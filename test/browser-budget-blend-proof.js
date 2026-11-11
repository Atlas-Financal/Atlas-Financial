'use strict';
// Fixture-only browser proof for the Budget bento skin.
// No live site, no provider, no new money arithmetic.
// APPROVED_REFERENCE_DIR=<approved Slack PNGs> PYTHON=<Python> CHROME_PATH=<Chromium> node test/browser-budget-blend-proof.js
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { captureSourceBinding, verifySourceBinding } = require('./proof-source-binding');
const { proveRiverPort, riverHarnessHtml } = require('./browser-budget-river-port');
const { provePanelRepairs } = require('./browser-budget-panel-repairs');
const dailyConsumerData = require('./fixtures/savings-daily-consumer-data');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs/proof');
fs.mkdirSync(outDir, { recursive: true });
const listedSources = spawnSync('git', ['ls-files', '-z', '--', 'public', 'scripts/*.js', 'test/fixtures',
  'test/proof-source-binding.js', 'test/test-proof-source-binding.js', 'test/test.js',
  'test/test-selector-formatters.js', 'test/test-budget-synchronized-wheels.js',
  'test/browser-budget-blend-proof.js', 'test/browser-budget-river-port.js', 'test/browser-budget-panel-repairs.js', 'data.json', 'package.json', 'package-lock.json'],
{ cwd: root, encoding: 'utf8' });
assert.equal(listedSources.status, 0, 'Tracked proof source scope must be readable.');
const sourceBinding = captureSourceBinding(root, listedSources.stdout.split('\0').filter(Boolean), process.env.PROOF_BASE_SHA || null);
const fx = require('./fixtures/budget-surface-data');
const householdAll = require('./fixtures/budget-household-all');
const servedSourceSha256 = {};

const parseRgb = value => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(value || '');
  if (!m) return null;
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: m[4] == null ? 1 : Number(m[4]) };
};
const lin = c => c.map(v => {
  const x = v / 255;
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
});
const lum = rgb => {
  const [r, g, b] = lin(rgb);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (fg, bg) => {
  const a = lum(fg), b = lum(bg);
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
};
const composite = (fg, bg) => {
  const a = fg.a == null ? 1 : fg.a;
  return fg.rgb.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const shots = [];
  let heroTerms = null;
  let currentFigureGap = null;
  const external = [];
  const errors = [];
  const contrasts = [];
  const focusWalks = [];
  try {
    const open = async (width, theme, options) => {
      const page = await browser.newPage({
        viewport: { width, height: 1000 },
        colorScheme: theme,
        reducedMotion: (options && options.reducedMotion) || 'no-preference',
        hasTouch: !!(options && options.hasTouch),
      });
      // This suite proves the Rings view. Bars, the default since #821's
      // Refined design, is proved in browser-budget-house-bars.js.
      await page.addInitScript(() => { try { localStorage.setItem('atlas-house-view', 'rings'); } catch (e) { /* default view */ } });
      await page.addInitScript(chosen => {
        try { localStorage.setItem('hfd-theme', chosen); } catch (e) {}
      }, theme);
      let data = options && options.data ? options.data : fx.served(options || {});
      page.on('pageerror', err => errors.push(`${width}/${theme}: ${err.message}`));
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== 'http://budget.test') {
          external.push(u.origin);
          return route.abort();
        }
        if (u.pathname === '/' && options?.riverHarness) return route.fulfill({body:riverHarnessHtml(theme),contentType:'text/html'});
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
        const relative = path.relative(root, file).split(path.sep).join('/');
        const bytes = fs.readFileSync(file);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        assert.equal(sha256, sourceBinding.files[relative]?.sha256, 'Served asset must match committed source: ' + relative);
        servedSourceSha256[relative] = sha256;
        return route.fulfill({ body: bytes, contentType: type });
      });
      await page.goto('http://budget.test/');
      if(!options?.riverHarness)await page.locator('[data-budget-surface]').waitFor();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      return page;
    };

    const settle = page => page.evaluate(() => new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const assertDialogPlacement = async (page, label) => {
      const placement = await page.locator('[data-budget-detail-sheet][open]').evaluate(async dialog => {
        // Inspect settled placement, including any decorative entrance motion.
        await Promise.all(dialog.getAnimations({ subtree: true })
          .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
          .map(animation => animation.finished.catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const box = dialog.getBoundingClientRect();
        const style = getComputedStyle(dialog);
        return {
          modal: dialog.matches(':modal'), position: style.position, background: style.backgroundColor,
          left: box.left, top: box.top, right: box.right, bottom: box.bottom,
          width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight,
        };
      });
      assert.equal(placement.position, 'fixed', label + ' keeps the native sheet fixed');
      assert.equal(placement.modal, true, label + ' remains a native modal');
      assert.ok(placement.width > 8 && placement.height > 8
        && placement.left >= -1 && placement.top >= -1
        && placement.right <= placement.viewportWidth + 1 && placement.bottom <= placement.viewportHeight + 1,
      label + ' keeps all four dialog edges in the viewport: ' + JSON.stringify(placement));
      const background = parseRgb(placement.background);
      assert.ok(background && background.a >= 0.99,
        label + ' preserves an opaque evidence background: ' + placement.background);
    };
    const openPeriodFigures = async (page, keyboard = false) => {
      const trigger = page.locator('[data-blend-figures-open]');
      if (!await page.locator('dialog[open] [data-budget-period-info-body]').count()) {
        if (keyboard) { await trigger.focus(); await page.keyboard.press('Enter'); }
        else await trigger.click();
      }
      await page.locator('dialog[open] [data-budget-period-info-body] .budget-granularity').waitFor({ state: 'visible' });
    };
    const moveRiver = async (page, direction) => {
      const before = await page.locator('[data-budget-window-range]').textContent();
      await page.locator('.river').focus();
      await page.keyboard.press(direction < 0 ? 'ArrowLeft' : 'ArrowRight');
      await page.waitForFunction(previous => document.querySelector('[data-budget-window-range]')?.textContent !== previous, before);
    };
    const assertBoardOrder = async (page, label, width) => {
      const result = await page.evaluate(() => {
        const selectors = [
          ['Hero', '.budget-blend-hero-layout'], ['Bills', '[data-budget-browse="bills"]'],
          ['Household', '[data-budget-browse="spending"]'],
          ['Cards', '.budget-blend-card-movements'], ['Savings', '[data-budget-savings-goals]'],
        ];
        const board = document.querySelector('.blend-board');
        const tiles = selectors.map(([name, selector]) => ({ name, node: board?.querySelector(selector) }));
        // Each tile sits in its own card-board wrapper (Refined step 3);
        // the board's children are the wrappers, in layout order.
        const nameOf = node => tiles.find(tile => tile.node === node || (tile.node && node.contains?.(tile.node)))?.name || null;
        const order = nodes => [...nodes].map(nameOf).filter(Boolean);
        const tabTiles = [...(board?.querySelectorAll('button, a[href], input, select, summary, [tabindex]') || [])]
          .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length
            && getComputedStyle(node).visibility !== 'hidden')
          .map(node => tiles.find(tile => tile.node?.contains(node))?.name).filter(Boolean);
        return {
          missing: tiles.filter(tile => !tile.node).map(tile => tile.name),
          direct: order(board?.children || []),
          tabTiles: tabTiles.filter((name, i) => name !== tabTiles[i - 1]),
        };
      });
      assert.deepEqual(result.missing, [], label + ': all five target tiles survive');
      assert.equal(await page.locator('.blend-income').count(), 0, label + ': separate Income tile removed');
      // Card board default order per width (owner design Refined, step 3).
      // No saved layout in a fresh page: the default applies. The DOM is the
      // layout order, so the focus order follows it at every width.
      const expected = width < 760 ? ['Hero', 'Bills', 'Household', 'Cards', 'Savings']
        : width < 1200 ? ['Hero', 'Bills', 'Household', 'Savings', 'Cards']
          : ['Hero', 'Household', 'Bills', 'Savings', 'Cards'];
      assert.deepEqual(result.direct, expected, label + ': card board DOM order');
      assert.deepEqual(result.tabTiles, expected, label + ': focusable DOM order follows the card board order');
    };

    const sampleContrast = async (page, selector, name) => {
      const row = await page.evaluate(({ selector, name }) => {
        const el = document.querySelector(selector);
        if (!el) return { name, missing: true };
        const fg = getComputedStyle(el).color;
        let node = el;
        let bg = 'rgba(0, 0, 0, 0)';
        const layers = [];
        while (node && node !== document.documentElement.parentElement) {
          const paint = getComputedStyle(node).backgroundColor;
          layers.push(paint);
          node = node.parentElement;
        }
        const size = parseFloat(getComputedStyle(el).fontSize) || 16;
        const weight = parseInt(getComputedStyle(el).fontWeight, 10) || 400;
        return { name, fg, layers, size, weight, text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 80) };
      }, { selector, name });
      if (row.missing) {
        contrasts.push(row);
        return;
      }
      let bg = [236, 238, 242];
      for (const layer of [...row.layers].reverse()) {
        const parsed = parseRgb(layer);
        if (!parsed || parsed.a === 0) continue;
        bg = parsed.a >= 0.99 ? parsed.rgb : composite(parsed, bg);
      }
      const fg = parseRgb(row.fg);
      const value = fg ? ratio(fg.rgb, bg) : 0;
      const large = row.size >= 24 || (row.size >= 18.66 && row.weight >= 700);
      contrasts.push({
        name, ratio: Math.round(value * 100) / 100, large,
        sampleType: row.text.trim() ? 'visible-text' : 'no-visible-text',
        pass: row.text.trim() ? value >= (large ? 3 : 4.5) : null,
        text: row.text, fg: row.fg, bg,
      });
    };

    const capture = async (page, file) => {
      await page.evaluate(() => {
        let style = document.getElementById('blend-capture-chrome');
        if (!style) {
          style = document.createElement('style');
          style.id = 'blend-capture-chrome';
          style.textContent = '.site-head, .sitenav, .sitenav-household { position: static !important; }';
          document.head.appendChild(style);
        }
        document.documentElement.style.scrollBehavior = 'auto';
        window.scrollTo(0, 0);
      });
      await page.screenshot({ path: path.join(outDir, file), fullPage: true, animations: 'disabled' });
      await page.evaluate(() => document.getElementById('blend-capture-chrome')?.remove());
      shots.push(file);
    };
    const riverPort = await proveRiverPort({ open, capture });
    const panelRepairs = await provePanelRepairs({ open, capture });

    const readFunding = page => page.evaluate(() => {
      const block = document.querySelector('[data-bad-terms]');
      const line = document.querySelector('.blend-after-funding');
      const value = line && line.querySelector('.blend-after-value');
      const bad = document.querySelector('[data-blend-term="balanceAfterDeductions"]');
      const clone = bad ? bad.cloneNode(true) : null;
      clone?.querySelector('.blend-after-funding')?.remove();
      const dollars = document.querySelector('.blend-dollar-group');
      const foot = document.querySelector('.blend-hero-foot');
      const ink = document.querySelector('.blend-hero-foot .operating-prompt');
      const est = line && line.querySelector('.est');
      const label = document.querySelector('[data-operating-question="07"] .blend-result-label');
      const hero = document.querySelector('.blend-hero');
      const lineBox = line ? line.getBoundingClientRect() : null;
      const dollarBox = dollars ? dollars.getBoundingClientRect() : null;
      const footBox = foot ? foot.getBoundingClientRect() : null;
      const labelBox = label ? label.getBoundingClientRect() : null;
      const heroBox = hero ? hero.getBoundingClientRect() : null;
      return {
        range: (document.querySelector('[data-budget-window-range]')?.textContent || '').replace(/\s+/g, ' ').trim(),
        faceAttr: block ? block.getAttribute('data-bad-terms-face') : '',
        trust: document.querySelector('[data-bad-term="balanceAfterDeductions"]')?.getAttribute('data-bad-term-trust') || '',
        qualifier: (document.querySelector('.blend-bad-qualifier')?.textContent || '').replace(/\s+/g, ' ').trim(),
        label: (label?.innerText || '').replace(/\s+/g, ' ').trim(),
        q07: (line?.innerText || '').replace(/\s+/g, ' ').trim(),
        lineLabel: line?.querySelector('.blend-after-label')?.textContent || '',
        srHidden: (() => {
          const hidden = line && line.querySelector('.blend-after-label');
          if (!hidden) return false;
          const style = getComputedStyle(hidden);
          const box = hidden.getBoundingClientRect();
          return hidden.classList.contains('budget-cash-sr') && style.position === 'absolute' && box.width <= 2 && box.height <= 2;
        })(),
        visibleLabel: line?.querySelector('.blend-after-visible')?.textContent || '',
        shown: [...(line ? line.childNodes : [])]
          .filter(node => !(node.classList && node.classList.contains('budget-cash-sr')))
          .map(node => node.textContent || '')
          .join('')
          .replace(/\s+/g, ' ')
          .trim(),
        valueText: value?.textContent || '',
        headline: (clone?.textContent || '').replace(/\s+/g, ' ').trim(),
        printed: (document.querySelector('[data-bad-term="balanceAfterDeductions"] [data-bad-term-value]')?.textContent || '').replace(/\s+/g, ' ').trim(),
        chip: !!(bad && bad.nextElementSibling && bad.nextElementSibling.classList.contains('blend-est')),
        lineChip: !!(line && line.querySelector('.blend-est')),
        clip: !!document.querySelector('[data-operating-question="07"] .budget-step-value > .blend-clip'),
        lineVisible: !!(lineBox && lineBox.height > 8 && lineBox.width > 8),
        fontSize: line ? getComputedStyle(line).fontSize : '',
        color: line ? getComputedStyle(line).color : '',
        ink: ink ? getComputedStyle(ink).color : '',
        valueWrap: value ? getComputedStyle(value).whiteSpace : '',
        estAfter: est ? getComputedStyle(est, '::after').content : '',
        estBeforeValue: !!(est && value && est.getBoundingClientRect().right <= value.getBoundingClientRect().left + 2),
        estimatedWidth: line && line.querySelector('.budget-cash-sr') ? line.querySelector('.budget-cash-sr').getBoundingClientRect().width : 0,
        school: [...document.querySelectorAll('[data-budget-funding-item]')].map(el => (el.textContent || '').replace(/\s+/g, ' ').trim()),
        terms: ['periodIncome', 'assignedBills', 'householdBudgetHold', 'balanceAfterDeductions'].map(key => {
          const slot = document.querySelector(`[data-blend-term="${key}"]`);
          const row = document.querySelector(`[data-bad-term="${key}"]`);
          const clone = slot ? slot.cloneNode(true) : null;
          clone?.querySelector('.blend-after-funding')?.remove();
          const amount = (row?.querySelector('[data-bad-term-amount]')?.textContent || '').replace(/\s+/g, ' ').trim();
          const shown = (clone?.textContent || '').replace(/\s+/g, ' ').trim();
          return {
            key,
            shown,
            chip: !!(slot && slot.nextElementSibling && slot.nextElementSibling.classList.contains('blend-est')),
            trust: row?.getAttribute('data-bad-term-trust') || '',
            amount,
            doubled: !!(amount && /≈|estimated/.test(shown)),
          };
        }),
        align: lineBox && dollarBox ? Math.abs(lineBox.left - dollarBox.left) : null,
        abovePills: !!(lineBox && footBox && lineBox.bottom <= footBox.top + 1 && lineBox.top >= (dollarBox ? dollarBox.bottom - 1 : 0)),
        gap: lineBox && dollarBox ? Math.round((lineBox.top - dollarBox.bottom) * 10) / 10 : null,
        labelInside: !!(labelBox && heroBox && labelBox.right <= heroBox.right + 1 && labelBox.left >= heroBox.left - 1),
      };
    });

    for (const width of [1440, 390, 320]) {
      for (const theme of ['light', 'dark']) {
        const page = await open(width, theme);
        await assertBoardOrder(page, `${width}/${theme}`, width);
        const facts = await page.evaluate(() => {
          const text = sel => (document.querySelector(sel)?.innerText || '').replace(/\s+/g, ' ');
          const tracks = [...document.querySelectorAll('[data-calendar-waterfall] .budget-waterfall-track')]
            .filter(row => getComputedStyle(row).display !== 'none');
          const escaped = [...document.querySelectorAll('.budget-step-summary,.budget-category-row,.budget-bill-row')]
            .filter(row => !row.closest('.blend-clip'))
            .flatMap(row => [...row.children].filter(el => {
              const a = el.getBoundingClientRect(), b = row.getBoundingClientRect();
              return a.width && (a.left < b.left - 1 || a.right > b.right + 1 || el.scrollWidth > el.clientWidth + 1);
            }).map(el => el.className));
          return {
            surface: document.querySelector('[data-budget-surface]')?.getAttribute('data-budget-surface'),
            theme: document.documentElement.getAttribute('data-theme'),
            cards: document.querySelectorAll('.budget-surface-grid > .budget-surface-card').length,
            today: getComputedStyle(document.querySelector('.budget-surface-today')).position,
            scroll: document.documentElement.scrollWidth <= innerWidth,
            tracks: tracks.length,
            escaped,
            hero: text('[data-budget-period-result]'),
            income: text('[data-operating-question="02"] > details > summary'),
            bills: text('[data-operating-question="04"] > details > summary'),
            after: (document.querySelector('[data-operating-question="05"] > details > summary')?.textContent || '').replace(/\s+/g, ' '),
            house: text('[data-operating-question="06"] > details > summary'),
            save: text('[data-operating-question="savings"] > details > summary'),
            closing: (document.querySelector('[data-bills-closing]')?.textContent || '').replace(/\s+/g, ' '),
            progress: (document.querySelector('[data-budget-window-progress]')?.getAttribute('aria-label')
              || document.querySelector('[data-budget-window-progress]')?.textContent || '').replace(/\s+/g, ' '),
            cash: text('[data-budget-cash-hero]'),
            motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
            face: (() => {
              const hero = document.querySelector('.blend-hero');
              const hb = hero.getBoundingClientRect();
              const box = el => el ? el.getBoundingClientRect() : null;
              const overlaps = (a, b) => !!(a && b && a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1);
              const termKey = { '02': 'periodIncome', '04': 'assignedBills', '06': 'householdBudgetHold' };
              const terms = ['02', '04', '06'].map(id => {
                const prompt = document.querySelector(`[data-operating-question="${id}"] .operating-prompt`);
                const painted = document.querySelector(`[data-operating-question="${id}"] .blend-term`);
                const row = document.querySelector(`[data-bad-term="${termKey[id]}"]`);
                const pb = box(prompt), vb = box(painted);
                const style = painted ? getComputedStyle(painted) : null;
                return {
                  id,
                  label: (prompt?.textContent || '').trim(),
                  shown: (painted?.textContent || '').replace(/\s+/g, ' ').trim(),
                  printed: (row?.querySelector('[data-bad-term-value]')?.textContent || '').replace(/\s+/g, ' ').trim(),
                  trust: row?.getAttribute('data-bad-term-trust') || '',
                  amountText: (row?.querySelector('[data-bad-term-amount]')?.textContent || '').replace(/\s+/g, ' ').trim(),
                  chip: !!(painted && painted.nextElementSibling && painted.nextElementSibling.classList.contains('blend-est')),
                  hook: painted?.getAttribute('data-blend-term') || '',
                  font: style ? parseFloat(style.fontSize) : 0,
                  ink: style ? style.color : '',
                  clipped: !pb || pb.left < hb.left - 1 || pb.right > hb.right + 1 || pb.top < hb.top - 1 || pb.bottom > hb.bottom + 1 || prompt.scrollHeight > prompt.clientHeight + 2,
                  valueClipped: !vb || vb.left < hb.left - 1 || vb.right > hb.right + 1 || vb.top < hb.top - 1 || vb.bottom > hb.bottom + 1 || painted.scrollWidth > painted.clientWidth + 2,
                  wrap: style ? style.overflowWrap : '',
                  break: style ? style.wordBreak : '',
                  rects: painted ? painted.getClientRects().length : 0,
                };
              });
              const badRow = document.querySelector('[data-bad-term="balanceAfterDeductions"]');
              const badShown = document.querySelector('[data-blend-term="balanceAfterDeductions"]');
              const badBlock = document.querySelector('[data-bad-terms]');
              const heroText = (hero.innerText || '').replace(/\s+/g, ' ');
              const big = {
                shown: (badShown?.textContent || '').replace(/\s+/g, ' ').trim(),
                printed: (badRow?.querySelector('[data-bad-term-value]')?.textContent || '').replace(/\s+/g, ' ').trim(),
                chip: !!(badShown && badShown.nextElementSibling && badShown.nextElementSibling.classList.contains('blend-est')),
                trust: badRow?.getAttribute('data-bad-term-trust') || '',
                amountText: (badRow?.querySelector('[data-bad-term-amount]')?.textContent || '').replace(/\s+/g, ' ').trim(),
                cents: (badShown?.querySelector('.blend-cents')?.textContent || ''),
                prefix: badShown?.querySelector('.blend-term-prefix')?.textContent || '',
                parked: !!(badBlock && badBlock.closest('.blend-hero-panel-body')),
                hidden: !badBlock || badBlock.getBoundingClientRect().height < 2,
                longOnFace: /Assigned bills \(incl|greater of plan or spent|Forecast's published terms/.test(heroText),
              };
              const values = terms.map(row => {
                const painted = document.querySelector(`[data-operating-question="${row.id}"] .blend-term`);
                return painted.getBoundingClientRect();
              });
              const minuses = [...document.querySelectorAll('.blend-minus')].map(el => el.getBoundingClientRect());
              const between = minuses.length === 2 && minuses.every((m, i) => {
                const left = values[i], right = values[i + 1];
                const mid = (m.top + m.bottom) / 2;
                const num = (left.top + left.bottom) / 2;
                return m.left >= left.right - 8 && m.right <= right.left + 8 && Math.abs(mid - num) < 16 && m.height > 10;
              });
              const pill = box(document.querySelector('.budget-today-cash'));
              const house = box(document.querySelector('[data-operating-question="06"] .operating-prompt'));
              const result = document.querySelector('[data-operating-question="07"] .budget-step-summary');
              const lines = (result?.innerText || '').split(/\n/).map(line => line.trim()).filter(Boolean);
              const foot = [...document.querySelectorAll('.blend-hero-foot > *')].map(el => el.getAttribute('data-operating-question') || el.getAttribute('data-bills-closing') || el.className);
              const savingsPill = document.querySelector('.blend-hero-foot [data-operating-question="savings"], .blend-hero-foot [data-budget-savings-stock]');
              const savingsBox = box(savingsPill);
              const savingsStyle = savingsPill ? getComputedStyle(savingsPill) : null;
              const flags = [...document.querySelectorAll('.blend-flag')].map(el => (el.textContent || '').trim());
              const caption = document.querySelector('.blend-ring-l');
              const captionStyle = caption ? getComputedStyle(caption) : null;
              const payDate = document.querySelector('.blend-pay-date');
              const payFace = document.querySelector('.blend-pay-face');
              const incomeBig = document.querySelector('.blend-income .blend-big');
              const incomeEst = document.querySelector('.blend-income .blend-est');
              const oneLine = values.length === 3 && Math.max(...values.map(v => v.top)) - Math.min(...values.map(v => v.top)) < 4;
              const incomePrinted = (() => {
                const ratio = document.querySelector('[data-operating-question="02"] [data-budget-ratio="income"]');
                if (!ratio) return '';
                const bits = node => {
                  const out = [];
                  const walk = el => {
                    if (!el) return;
                    if (el.nodeType === 3) {
                      const raw = (el.textContent || '').replace(/\s+/g, ' ').trim();
                      if (raw) out.push(raw);
                      return;
                    }
                    if (el.nodeType !== 1) return;
                    if (el.classList.contains('blend-est') || el.classList.contains('blend-term')) return;
                    for (const child of el.childNodes) walk(child);
                  };
                  walk(node);
                  return out.join(' ');
                };
                const parts = [];
                const actual = bits(ratio.querySelector('[data-budget-ratio-actual]'));
                if (actual) parts.push(actual);
                const ofPlanned = [...ratio.children].find(node => node.classList.contains('budget-cash-sr') && /of planned/i.test(node.textContent || ''));
                if (ofPlanned) {
                  const slash = [...ratio.children].find(node => node.getAttribute('aria-hidden') === 'true' && /\//.test(node.textContent || ''));
                  if (slash) parts.push(bits(slash));
                  parts.push(bits(ofPlanned));
                  const plan = bits(ratio.querySelector('[data-budget-ratio-plan]'));
                  if (plan) parts.push(plan);
                }
                return parts.join(' ').replace(/\s+/g, ' ').trim();
              })();
              const incomeShown = (document.querySelector('.blend-income .blend-muted')?.textContent || '').replace(/\s+/g, ' ').trim();
              const figure = document.querySelector('[data-operating-question="07"]');
              const pillRow = document.querySelector('.blend-hero-foot');
              const figureGap = figure && pillRow ? Math.round((pillRow.getBoundingClientRect().top - figure.getBoundingClientRect().bottom) * 10) / 10 : null;
              const pills = [...document.querySelectorAll('.blend-hero-foot > *')].filter(el => {
                const box = el.getBoundingClientRect();
                return getComputedStyle(el).display !== 'none' && box.height > 1 && box.width > 1;
              }).map(el => {
                const b = el.getBoundingClientRect();
                return {
                  id: el.classList.contains('blend-split') ? 'split' : (el.getAttribute('data-operating-question') || (el.hasAttribute('data-bills-closing') ? 'closing' : 'pill')),
                  top: Math.round(b.top),
                  width: Math.round(b.width),
                  height: Math.round(b.height),
                  text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
                  inside: b.left >= hb.left - 1 && b.right <= hb.right + 1,
                  fits: el.scrollWidth <= el.clientWidth + 1,
                };
              });
              const footBox = document.querySelector('.blend-hero-foot')?.getBoundingClientRect();
              const billsHead = document.querySelector('.blend-bills-head');
              const billsTitle = billsHead && billsHead.querySelector('.blend-tile-title');
              const billsOf = billsHead && billsHead.querySelector('.blend-bills-of');
              const billsToggle = document.querySelector('[data-blend-bills-open]');
              const titleBox = box(billsTitle);
              const ofBox = box(billsOf);
              const bills = billsHead && titleBox && ofBox ? {
                oneLine: getComputedStyle(billsOf).display === 'none'
                  ? !!billsHead.querySelector('.blend-flag') && !billsOf.classList.contains('is-unavailable')
                  : billsOf.scrollWidth <= billsOf.clientWidth + 1 && billsOf.getClientRects().length === 1,
                sameRow: Math.abs((ofBox.top + ofBox.height / 2) - (titleBox.top + titleBox.height / 2)) < 14,
                right: ofBox.left >= titleBox.right - 4,
                toggleInHead: !!(billsToggle && billsHead.contains(billsToggle)),
                crowded: ofBox.top >= titleBox.bottom + 8,
              } : null;
              const pillHeights = pills.length ? {
                spread: Math.max(...pills.map(row => row.height || 0)) - Math.min(...pills.map(row => row.height || 0)),
              } : null;
              const baselines = [...document.querySelectorAll('.blend-hero-foot > *')].filter(el => getComputedStyle(el).display !== 'none').map(el => {
                const label = el.querySelector('.operating-prompt, h2');
                const value = el.querySelector('.budget-step-value, .budget-bills-closing-value');
                const a = label && label.getClientRects()[0];
                const b = value && value.getClientRects()[0];
                return { delta: a && b ? Math.abs(a.bottom - b.bottom) : 0 };
              });
              const savedLines = [...document.querySelectorAll('.blend-goal-saved, .blend-goal-needed')].map(el => (el.textContent || '').trim());
              const otherName = document.querySelector('.blend-other-name');
              const otherState = document.querySelector('.blend-other-state');
              const otherStyle = otherName ? getComputedStyle(otherName) : null;
              const other = otherName ? {
                ellipsis: otherStyle.textOverflow === 'ellipsis' || (otherState && getComputedStyle(otherState).textOverflow === 'ellipsis'),
                nameLine: otherName.scrollWidth <= otherName.clientWidth + 1 && otherName.getClientRects().length === 1,
                stateBelow: !otherState || otherState.getBoundingClientRect().top >= otherName.getBoundingClientRect().bottom - 2,
              } : null;
              const qualifier = document.querySelector('.card-movement-qualifier');
              const qualifierStyle = qualifier ? getComputedStyle(qualifier) : null;
              const cardQualifier = qualifier ? {
                ellipsis: qualifierStyle.textOverflow === 'ellipsis' || qualifierStyle.whiteSpace === 'nowrap',
                clipped: qualifier.scrollWidth > qualifier.clientWidth + 1,
              } : null;
              return {
                terms, big, between,
                pillOverlapsHouse: overlaps(pill, house),
                strayLine: lines.some(line => /^[=—−\-]$/.test(line)),
                resultLine: lines.find(line => /Balance After Deductions/.test(line)) || '',
                foot,
                savingsPad: savingsStyle ? parseFloat(savingsStyle.paddingLeft) : 0,
                savingsInside: !!(savingsBox && savingsPill && savingsPill.scrollWidth <= savingsPill.clientWidth + 1),
                flags,
                captionWrap: captionStyle ? captionStyle.whiteSpace : '',
                captionEllipsis: captionStyle ? captionStyle.textOverflow : '',
                dateOverlapsRing: overlaps(box(payDate), box(payFace)),
                dateOneLine: !!(payDate && payDate.scrollWidth <= payDate.clientWidth + 1),
                estOverlapsIncome: overlaps(box(incomeBig), box(incomeEst)),
                oneLine,
                compactEquation: getComputedStyle(hero).gridTemplateColumns.split(' ').length === 2,
                incomeShown,
                incomePrinted,
                figureGap,
                pills,
                footWidth: footBox ? Math.round(footBox.width) : 0,
                bills,
                pillHeights,
                baselines,
                savedLines,
                other,
                cardQualifier,
                afterLine: !!document.querySelector('.blend-after-funding'),
                qualifier: (document.querySelector('.blend-bad-qualifier')?.textContent || '').trim(),
                incomeTitle: (document.querySelector('.blend-income .blend-tile-title')?.textContent || '').trim(),
                incomeAccessible: document.querySelector('.blend-income')?.getAttribute('aria-label') || '',
                incomeLong: (document.querySelector('.blend-income-long')?.textContent || '').trim(),
                heroIncomeReceived: /received/i.test((document.querySelector('[data-operating-question="02"] .operating-prompt')?.textContent || '') + ' ' + (document.querySelector('[data-operating-question="02"] .blend-term')?.textContent || '')),
                payRing: !!document.querySelector('.blend-pay-face'),
                payMain: (document.querySelector('.blend-pay-main')?.textContent || '').trim(),
              };
            })(),
            shown: ['[data-operating-question="02"] .blend-term'].map(sel => {
              const el = document.querySelector(sel);
              if (!el) return sel + ':missing';
              const box = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              const visible = box.width > 8 && box.height > 8 && style.visibility !== 'hidden'
                && style.display !== 'none' && style.position !== 'absolute';
              return visible ? '' : sel;
            }).filter(Boolean),
          };
        });
        if (facts.cards !== 1 || facts.today !== 'static' || !facts.scroll || facts.tracks !== 0 || facts.escaped.length || facts.shown.length) {
          errors.push(`${width}/${theme} geometry ${JSON.stringify({ cards: facts.cards, today: facts.today, scroll: facts.scroll, tracks: facts.tracks, escaped: facts.escaped.slice(0, 4), shown: facts.shown })}`);
        }
        if (width === 320 || width === 390) {
          const clear = await page.evaluate(() => {
            const nav = document.querySelector('.sitenav, .sitenav-household');
            const pad = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
            const rootStyle = getComputedStyle(document.documentElement);
            const dock = parseFloat(rootStyle.getPropertyValue('--nav-dock-height')) || 0;
            const lift = parseFloat(rootStyle.getPropertyValue('--nav-dock-lift')) || 0;
            return { nav: !!nav, pad, dock, lift };
          });
          if (clear.nav || clear.pad > 96.5) {
            errors.push(`${width}/${theme} dock still reserved ${JSON.stringify(clear)}`);
          }
        }
        for (const [key, needle] of [
          ['hero', 'Balance After Deductions'],
          ['income', 'Income'],
          ['bills', 'Bills'],
          ['after', 'Balance after bills'],
          ['house', 'Household budget'],
          ['save', 'Planned Savings'],
          ['closing', 'Expected Bills balance at period end'],
          ['progress', 'Day 7'],
        ]) {
          if (!facts[key] || !facts[key].includes(needle)) errors.push(`${width}/${theme} missing ${key} ${needle}`);
        }
        const face = facts.face || {};
        if (face.afterLine || face.qualifier) {
          errors.push(`${width}/${theme} current period showed proposed-funding chrome ${JSON.stringify({ after: face.afterLine, qualifier: face.qualifier })}`);
        }
        if (face.incomeTitle || face.incomeAccessible || face.incomeLong !== 'Period income, counted in Balance After Deductions' || face.heroIncomeReceived || !face.payRing || face.payMain) {
          errors.push(`${width}/${theme} income or payday ${JSON.stringify({ title: face.incomeTitle, long: face.incomeLong, received: face.heroIncomeReceived, ring: face.payRing, main: face.payMain })}`);
        }
        const minFont = width >= 1000 ? 20 : width <= 360 ? 13 : 15;
        (face.terms || []).forEach(term => {
                if (term.clipped || term.valueClipped || term.font < minFont || term.wrap !== 'normal' || term.break !== 'normal' || term.rects !== 1) {
            errors.push(`${width}/${theme} equation ${JSON.stringify(term)}`);
          }
        });
        if (!face.compactEquation && !face.between) errors.push(`${width}/${theme} minus signs are not between the terms`);
        if (face.pillOverlapsHouse) errors.push(`${width}/${theme} Bills account pill overlaps Household budget`);
        if (face.strayLine || !/^=\s*Balance After Deductions/.test(face.resultLine || '')) {
          errors.push(`${width}/${theme} result label ${JSON.stringify(face.resultLine)} stray ${face.strayLine}`);
        }
        const hooks = { '02': 'periodIncome', '04': 'assignedBills', '06': 'householdBudgetHold' };
        const expectShown = row => row.trust === 'unavailable' ? 'Unavailable' : (row.amountText || row.printed);
        const expectChip = row => !!(row.amountText && row.trust === 'estimated');
        (face.terms || []).forEach(term => {
          if (term.hook !== hooks[term.id] || term.shown !== expectShown(term) || term.chip !== expectChip(term)
            || (term.amountText && /≈|estimated/.test(term.shown))) {
            errors.push(`${width}/${theme} term slot ${JSON.stringify(term)}`);
          }
        });
        const big = face.big || {};
        if (big.shown !== expectShown(big) || big.chip !== expectChip(big) || (big.amountText && /≈|estimated/.test(big.shown))
          || !big.parked || !big.hidden || big.longOnFace) {
          errors.push(`${width}/${theme} bad number ${JSON.stringify(big)}`);
        }
        if (big.printed && big.printed !== 'Unavailable' && /\$[\d,]+\.\d{2}/.test(big.printed) && !big.cents) {
          errors.push(`${width}/${theme} cents were not split from the displayed string ${JSON.stringify(big)}`);
        }
        if (width === 1440 && theme === 'light') {
          heroTerms = face.terms.map(term => ({
            key: hooks[term.id], shown: term.shown, chip: term.chip, trust: term.trust,
          })).concat([{ key: 'balanceAfterDeductions', shown: big.shown, chip: big.chip, trust: big.trust }]);
          console.log('pp+0 hero ' + JSON.stringify(heroTerms));
          const port = await page.evaluate(() => {
            const family = getComputedStyle(document.querySelector('.budget-bento') || document.body).fontFamily;
            const section = document.querySelector('[data-budget-funding-section]');
            const box = section ? section.getBoundingClientRect() : null;
            const nav = document.querySelector('[data-bad-river]');
            const labels = [...document.querySelectorAll('.g-river-wrap .rv')].map(el => el.dataset.riverNativeValue || (el.textContent || '').trim());
            return {
              family,
              fundingInPanel: !!(section && section.closest('.blend-goals-panel')),
              fundingHeight: box ? box.height : -1,
              river: nav ? nav.getAttribute('data-bad-river') : '',
              riverLabels: labels.slice(0, 3),
              riverCount: labels.length,
            };
          });
          if (!/Geist/.test(port.family)) errors.push(`computed font ${port.family}`);
          if (!port.fundingInPanel || port.fundingHeight > 8) errors.push(`funding still on the face ${JSON.stringify(port)}`);
          const riverContract = await page.evaluate(() => {
            const list = document.querySelector('ol[data-bad-timeline]');
            const nav = document.querySelector('[data-bad-river]');
            const labels = [...document.querySelectorAll('.g-river-wrap .rv')].map(el => el.dataset.riverNativeValue || (el.textContent || '').trim());
            const items = list ? [...list.querySelectorAll(':scope > li')] : [];
            const kept = items.filter(li => li.getAttribute('data-bad-timeline-start') && li.getAttribute('data-bad-timeline-end'));
            const expected = kept.map(li => {
              const trust = li.getAttribute('data-bad-term-trust') || '';
              const amount = (li.querySelector('[data-bad-term-amount]')?.textContent || '').replace(/\s+/g, ' ').trim();
              return !['calculated', 'estimated'].includes(trust) || !amount ? 'Unavailable' : amount;
            });
            return {
              mode: nav ? nav.getAttribute('data-bad-river') : '',
              state: nav ? nav.getAttribute('data-state') : '',
              labels,
              expected,
              rows: items.length,
              kept: kept.length,
              hidden: !!(list && list.hidden && list.getAttribute('aria-hidden') === 'true'),
            };
          });
          if (!riverContract.rows || !riverContract.kept) {
            if (port.river !== 'absent' || port.riverCount < 2 || port.riverLabels.some(label => label !== '—')) {
              errors.push(`river without a kept timeline row ${JSON.stringify(port)}`);
            }
          } else if (riverContract.mode !== 'printed' || !riverContract.hidden
            || riverContract.labels.length !== riverContract.kept
            || riverContract.labels.some((label, i) => label !== riverContract.expected[i])) {
            errors.push(`river timeline ${JSON.stringify({ mode: riverContract.mode, rows: riverContract.rows, kept: riverContract.kept, labels: riverContract.labels.slice(0, 4), expected: riverContract.expected.slice(0, 4) })}`);
          }
        }
        if ((face.terms || []).find(term => term.id === '06')?.label !== 'Household budget') {
          errors.push(`${width}/${theme} household label ${JSON.stringify(face.terms)}`);
        }
        if (!face.compactEquation && !face.oneLine) errors.push(`${width}/${theme} equation is not one line`);
        if (face.foot?.[0] !== 'savings' || !/blend-split/.test(String(face.foot?.[1] || ''))) {
          errors.push(`${width}/${theme} pill order ${JSON.stringify(face.foot)}`);
        }
        if (face.savingsPad < 8 || !face.savingsInside) {
          errors.push(`${width}/${theme} savings pill pad ${face.savingsPad} inside ${face.savingsInside}`);
        }
        assert.equal(face.incomeShown, '', 'Removed tile has no copied income sentence');
        if (width === 1440 && theme === 'light') {
          currentFigureGap = face.figureGap;
          console.log('pp+0 income ' + face.incomeShown);
        }
        const overflow = (face.pills || []).filter(pill => pill.id !== 'split' && (!pill.inside || !pill.fits));
        if (overflow.length) errors.push(`${width}/${theme} pill overflow ${JSON.stringify({ foot: face.footWidth, pills: face.pills })}`);
        if (width >= 1000) {
          const tops = (face.pills || []).map(pill => pill.top);
          const oneRow = tops.length > 1 && Math.max(...tops) - Math.min(...tops) < 4;
          if (!oneRow) errors.push(`${width}/${theme} pills not one line ${JSON.stringify({ foot: face.footWidth, pills: face.pills })}`);
        }
        if ((face.flags || []).some(flag => /^(To confirm|Overdue) 0$/.test(flag))) {
          errors.push(`${width}/${theme} zero pill ${JSON.stringify(face.flags)}`);
        }
        if (face.captionWrap === 'nowrap' || face.captionEllipsis === 'ellipsis') {
          errors.push(`${width}/${theme} caption ${face.captionWrap} ${face.captionEllipsis}`);
        }
        if (width <= 390 && face.estOverlapsIncome) {
          errors.push(`${width}/${theme} est overlaps income`);
        }
        if (face.bills && (!face.bills.toggleInHead || !face.bills.oneLine)) {
          errors.push(`${width}/${theme} bills head ${JSON.stringify(face.bills)}`);
        }
        if (width >= 1000 && face.bills && (!face.bills.sameRow || !face.bills.right || face.bills.crowded)) {
          errors.push(`${width}/${theme} bills head row ${JSON.stringify(face.bills)}`);
        }
        if (width <= 390) {
          const save = (face.pills || []).find(pill => pill.id === 'savings');
          const split = (face.pills || []).find(pill => pill.id === 'split');
          if (save && (save.height > 64 || save.width < (face.footWidth || 0) - 24)) {
            errors.push(`${width}/${theme} savings pill ${JSON.stringify(save)}`);
          }
          if (split && split.width < (face.footWidth || 0) - 28) {
            errors.push(`${width}/${theme} split width ${JSON.stringify({ foot: face.footWidth, split })}`);
          }
        }
        if (width >= 1000 && face.baselines && face.baselines.some(row => row.delta > 3)) {
          errors.push(`${width}/${theme} pill baseline ${JSON.stringify(face.baselines)}`);
        }
        if ((face.savedLines || []).some(line => /Saved Unavailable/.test(line))) {
          errors.push(`${width}/${theme} saved unavailable ${JSON.stringify(face.savedLines)}`);
        }
        if (width <= 390 && face.other && (face.other.ellipsis || !face.other.nameLine)) {
          errors.push(`${width}/${theme} other row ${JSON.stringify(face.other)}`);
        }
        if (width <= 390 && face.cardQualifier && (face.cardQualifier.ellipsis || face.cardQualifier.clipped)) {
          errors.push(`${width}/${theme} card subtitle ${JSON.stringify(face.cardQualifier)}`);
        }
        const layout = await page.evaluate(() => {
          const box = el => el ? el.getBoundingClientRect() : null;
          const hits = (a, b) => !!(a && b && a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1);
          const centsEl = document.querySelector('.blend-cents');
          const estEl = document.querySelector('[data-operating-question="07"] .budget-step-value > .blend-est');
          const cents = box(centsEl);
          const est = box(estEl);
          const top = box(document.querySelector('.blend-hero-top'));
          const cash = document.querySelector('.blend-hero-top .budget-today-cash');
          const cashBox = box(cash);
          const cashShown = !!(cash && getComputedStyle(cash).display !== 'none' && cashBox && cashBox.width > 8);
          const income = box(document.querySelector('.blend-income'));
          const pay = box(document.querySelector('.blend-pay'));
          const meta = document.querySelector('.blend-income-in');
          const metaBox = box(meta);
          const deps = [...document.querySelectorAll('.blend-income .blend-p-lbl, .blend-income .blend-deposit')].map(box).filter(row => row && row.width > 0 && row.height > 0);
          let depOverlap = false;
          for (let i = 0; i < deps.length; i++) {
            for (let j = i + 1; j < deps.length; j++) if (hits(deps[i], deps[j])) depOverlap = true;
          }
          const rings = [...document.querySelectorAll('[data-budget-browse="spending"] .blend-ring')].slice(0, 3).map(box);
          const ringTops = rings.map(row => row.top);
          const cardHead = document.querySelector('.card-movement-heading');
          const cardIcon = box(cardHead && cardHead.querySelector('.blend-tile-ico'));
          const cardTitle = box(cardHead && (cardHead.querySelector('.blend-tile-title') || cardHead.querySelector('h2')));
          const houseHead = document.querySelector('[data-budget-browse="spending"] > header');
          const houseIcon = box(houseHead && houseHead.querySelector('.blend-tile-ico'));
          const houseTitle = box(houseHead && houseHead.querySelector('h2'));
          const paired = (icon, title) => !!(icon && title && title.left >= icon.left && title.left - icon.right < 24 && Math.abs(title.top - icon.top) < 24);
          return {
            estChip: !!(estEl && !estEl.closest('.blend-clip') && getComputedStyle(estEl).display !== 'none' && est && est.width > 8),
            estBeside: !!(cents && est && estEl && !estEl.closest('.blend-clip') && est.left >= cents.right - 2 && est.left - cents.right < 40 && Math.abs(est.top - cents.top) < 28),
            termChips: [...document.querySelectorAll('.blend-hero [data-operating-question="02"] .budget-step-value > .blend-est, .blend-hero [data-operating-question="04"] .budget-step-value > .blend-est, .blend-hero [data-operating-question="06"] .budget-step-value > .blend-est')].map(chip => {
              const amount = chip.previousElementSibling;
              if (!amount) return { beside: false, below: true };
              const a = amount.getBoundingClientRect();
              const b = chip.getBoundingClientRect();
              return {
                hidden: b.width <= 2 && b.height <= 2 && getComputedStyle(chip).overflow === 'hidden',
                beside: b.left >= a.right - 2 && b.top < a.bottom - 1,
                below: b.top >= a.bottom - 1,
              };
            }),
            pillRight: !!(cashShown && top && top.right - cashBox.right < 24 && cashBox.top >= top.top - 2 && cashBox.bottom <= top.bottom + 2),
            incomeInside: !(metaBox && income) || (metaBox.right <= income.right + 1 && metaBox.left >= income.left - 1 && metaBox.bottom <= income.bottom + 1),
            stacked: !income,
            separate: !hits(income, pay),
            payHidden: !!(pay && pay.width <= 2 && pay.height <= 2),
            depOverlap,
            ringsAcross: rings.length < 3 || Math.max(...ringTops) - Math.min(...ringTops) < 12,
            cardPair: paired(cardIcon, cardTitle),
            housePair: paired(houseIcon, houseTitle),
            // Vertical gap between cards that share a column band on the card
            // board: for each card, the nearest card starting below it that
            // overlaps it horizontally.
            columnGaps: (() => {
              const cards = [...document.querySelectorAll('.blend-board > .blend-w')].map(el => el.getBoundingClientRect()).filter(row => row.height > 8);
              return cards.map(a => {
                const below = cards.filter(b => b !== a && b.top >= a.bottom - 1 && b.left < a.right - 1 && b.right > a.left + 1)
                  .map(b => Math.round(b.top - a.bottom));
                return below.length ? [Math.min(...below)] : [];
              });
            })(),
            phoneOrder: ['.g-river-wrap', '.blend-hero', '[data-budget-browse="bills"]', '[data-budget-browse="spending"]', '.budget-blend-card-movements', '[data-budget-savings-goals]'].map(sel => {
              const el = document.querySelector(sel);
              return el ? Math.round(el.getBoundingClientRect().top) : null;
            }),
            ringWidths: [...document.querySelectorAll('.blend-ring-g')].map(el => Math.round(el.getBoundingClientRect().width)),
            goalSlack: (() => {
              const tile = document.querySelector('[data-budget-savings-goals]');
              if (!tile) return null;
              const nodes = [...tile.querySelectorAll('li, p, h2, .blend-goals-costs')]
                .filter(el => !el.closest('.blend-goals-source, details:not([open]), [hidden]') && el.getBoundingClientRect().height > 4);
              if (!nodes.length) return null;
              return Math.round(tile.getBoundingClientRect().bottom - Math.max(...nodes.map(el => el.getBoundingClientRect().bottom)));
            })(),
            heroSlack: (() => {
              const tile = document.querySelector('.blend-hero');
              const foot = tile && tile.querySelector('.blend-hero-foot');
              if (!tile || !foot) return null;
              return Math.round(tile.getBoundingClientRect().bottom - foot.getBoundingClientRect().bottom);
            })(),
            incomeSlack: (() => {
              const tile = document.querySelector('.blend-income');
              const pulse = tile && tile.querySelector('.blend-dep-pulse');
              if (!tile || !pulse) return null;
              return Math.round(tile.getBoundingClientRect().bottom - pulse.getBoundingClientRect().bottom);
            })(),
            pillLine: (() => {
              const summary = document.querySelector('.blend-hero-pill .budget-step-summary');
              if (!summary) return null;
              const mid = el => {
                const row = el && el.getBoundingClientRect();
                return row && row.height ? row.top + row.height / 2 : null;
              };
              return [mid(summary.querySelector('.blend-save-ico')), mid(summary.querySelector('.operating-prompt')), mid(summary.querySelector('.budget-step-value'))];
            })(),
          };
        });
        if (layout.estChip) errors.push(`${width}/${theme} repeated est badge remains visible`);
        if ((layout.termChips || []).some(row => !row.hidden)) {
          errors.push(`${width}/${theme} term est badge remains visible ${JSON.stringify(layout.termChips)}`);
        }
        if (!layout.pillRight) errors.push(`${width}/${theme} Bills account pill is not at the right of the hero top`);
        if (!layout.incomeInside) errors.push(`${width}/${theme} received amount leaves the Income tile`);
        if (!layout.separate || layout.depOverlap) errors.push(`${width}/${theme} income track overlap ${JSON.stringify(layout)}`);
        if (width <= 400 && !layout.stacked) errors.push(`${width}/${theme} income is not above household`);
        if (width <= 400 && !layout.ringsAcross) errors.push(`${width}/${theme} household rings are not one row`);
        if (!layout.payHidden) errors.push(`${width}/${theme} payday tile is still on the face`);
        if (!layout.cardPair || !layout.housePair) errors.push(`${width}/${theme} header alignment ${JSON.stringify(layout)}`);
        if (width >= 1000) {
          // Content-height card board: a card below a shorter neighbour can sit
          // lower than the row gap, so only a minimum separation is fixed.
          const gaps = (layout.columnGaps || []).flat();
          if (!gaps.length || gaps.some(gap => gap < 8)) {
            errors.push(`${width}/${theme} column gaps ${JSON.stringify(layout.columnGaps)}`);
          }
          if ((layout.ringWidths || []).some(size => size < 96)) {
            errors.push(`${width}/${theme} ring width ${JSON.stringify(layout.ringWidths)}`);
          }
          if (layout.goalSlack == null || layout.goalSlack < 0 || layout.goalSlack > 48 || layout.heroSlack == null || layout.heroSlack > 40) {
            errors.push(`${width}/${theme} tile slack ${JSON.stringify({ goal: layout.goalSlack, hero: layout.heroSlack, income: layout.incomeSlack })}`);
          }
        }
        if (width <= 400) {
          const tops = layout.phoneOrder || [];
          const ordered = tops.every((top, index) => index === 0 || (top != null && tops[index - 1] != null && top > tops[index - 1]));
          if (!ordered) errors.push(`${width}/${theme} phone order ${JSON.stringify(tops)}`);
        }
        if (layout.pillLine && layout.pillLine.every(value => value != null)) {
          const spread = Math.max(...layout.pillLine) - Math.min(...layout.pillLine);
          if (spread > 8) errors.push(`${width}/${theme} savings pill baseline ${JSON.stringify(layout.pillLine)}`);
        }
        if (width === 1440 && theme === 'dark') {
          const toggle = await page.evaluate(() => {
            const buttons = [...document.querySelectorAll('[data-budget-period-info-body] .budget-granularity-btn')];
            return buttons.map(el => ({
              text: (el.textContent || '').trim(),
              pressed: el.getAttribute('aria-pressed'),
              bg: getComputedStyle(el).backgroundColor,
              fg: getComputedStyle(el).color,
            }));
          });
          const on = toggle.find(row => row.pressed === 'true');
          const off = toggle.find(row => row.pressed === 'false');
          if (!on || !off || on.text !== 'Pay period' || on.bg === off.bg || on.fg === off.fg) {
            errors.push(`dark toggle ${JSON.stringify(toggle)}`);
          }
        }
        if (width === 320) {
          await page.evaluate(() => {
            const section = document.querySelector('[data-budget-browse="spending"]');
            const row = [...section.querySelectorAll('.budget-category-row')]
              .find(item => item.getAttribute('data-budget-category-open') !== 'other-spending');
            row.classList.add('is-over');
            row.querySelector('.budget-category-status').textContent = '$295.14 over';
            const bento = document.querySelector('[data-budget-bento]');
            bento.removeAttribute('data-blend-ready');
            bento.querySelector('[data-blend-rings]')?.remove();
            bento.querySelector('.blend-other')?.remove();
            document.getElementById('operating-surface-body').appendChild(document.createTextNode(''));
          });
          await page.locator('.blend-over-pill').waitFor();
          const narrow = await page.evaluate(() => {
            const tiles = [...document.querySelectorAll('.blend-hero, .blend-income, .blend-pay, [data-budget-browse="bills"], [data-budget-browse="spending"], .budget-blend-card-movements, [data-budget-savings-goals]')];
            const bad = [];
            const skip = '.blend-clip, .budget-cash-sr, .blend-hero-panel-body, .blend-house-body, .blend-sky, svg, svg *';
            tiles.forEach(tile => {
              tile.querySelectorAll('*').forEach(el => {
                if (el.closest(skip) || el.matches('svg, svg *')) return;
                const style = getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') return;
                const box = el.getBoundingClientRect();
                if (box.width < 8 || box.height < 8) return;
                const own = [...el.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('');
                const sample = (own || (el.children.length ? '' : el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 70);
                const label = ((el.className && el.className.baseVal) || el.className || el.tagName || '').toString().slice(0, 80);
                if (/\$/.test(sample) && el.scrollWidth > el.clientWidth + 1) bad.push({ kind: 'scroll', label, sample, sw: el.scrollWidth, cw: el.clientWidth });
                if (/\$/.test(sample) && style.textOverflow === 'ellipsis') bad.push({ kind: 'ellipsis', label, sample });
              });
            });
            const ring = document.querySelector('.blend-ring.is-over');
            const pill = ring && ring.querySelector('.blend-over-pill');
            const sr = pill && pill.querySelector('.budget-cash-sr');
            const word = pill && [...pill.children].find(el => !el.classList.contains('budget-cash-sr'));
            const state = document.querySelector('.blend-other-state');
            const plan = document.querySelector('.blend-other .blend-of-plan');
            const hits = (a, b) => !!(a && b && a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1);
            return {
              bad: bad.slice(0, 6),
              centre: (ring?.querySelector('.blend-ring-v')?.textContent || '').replace(/\s+/g, ' ').trim(),
              centreName: (() => { const id = ring?.getAttribute('data-blend-cat'); const src = id && document.querySelector('[data-budget-category-open="' + CSS.escape(id) + '"]'); return (src?.querySelector('.budget-category-name')?.textContent || '').replace(/\s+/g, ' ').trim(); })(),
              word: (word?.textContent || '').replace(/\s+/g, ' ').trim(),
              sr: (sr?.textContent || '').replace(/\s+/g, ' ').trim(),
              srReachable: !!(sr && getComputedStyle(sr).display !== 'none' && !sr.closest('[aria-hidden="true"]')),
              pillEllipsis: pill ? getComputedStyle(pill).textOverflow : '',
              otherOverlap: hits(state && state.getBoundingClientRect(), plan && plan.getBoundingClientRect()),
            };
          });
          if (narrow.bad.length || !narrow.centreName || narrow.centre !== narrow.centreName || narrow.word !== 'Over plan'
            || narrow.sr !== '$295.14 over' || !narrow.srReachable
            || narrow.pillEllipsis === 'ellipsis' || narrow.otherOverlap) {
            errors.push(`${width}/${theme} narrow overflow ${JSON.stringify(narrow)}`);
          }
        }
        const file = `budget-blend-${width}-${theme}.png`;
        await capture(page, file);
        if (width === 1440) {
          for (const [sel, name] of [
            ['[data-budget-window-range]', `${theme} period range`],
            ['[data-budget-window-progress] .blend-pay-date', `${theme} payday date`],
            ['[data-budget-window-progress] .blend-pay-num', `${theme} day count`],
            ['[data-bills-closing] h2', `${theme} closing label`],
            ['[data-operating-question="07"] .operating-prompt', `${theme} result label`],
            ['[data-operating-question="02"] .operating-prompt', `${theme} income label`],
            ['#budget-spending-heading', `${theme} household heading`],
            ['[data-budget-savings-goals] h3', `${theme} goals heading`],
          ]) await sampleContrast(page, sel, name);
        }
        await page.close();
      }
    }


    // The river controls dates; Month is reached through native Period figures.
    for (const width of [1440, 390]) {
      const controls = await open(width, 'light');
      assert.equal(await controls.locator('.playhead-pill').evaluate(el => el.tagName === 'DIV' && el.getAttribute('aria-hidden') === 'true'), true);
      assert.equal(await controls.locator('[data-budget-window-choose]').isVisible(), false);
      await moveRiver(controls, 1);
      await settle(controls);
      assert.equal(await controls.locator('.river').evaluate(el => el === document.activeElement && el.getBoundingClientRect().height > 8), true,
        'Period remount restores visible river focus at ' + width);
      await openPeriodFigures(controls, width === 1440);
      await controls.locator('[data-budget-granularity="month"]').click();
      await controls.locator('[data-budget-surface="month"]').waitFor();
      await settle(controls);
      assert.equal(await controls.locator('[data-budget-granularity="month"]').evaluate(el => el === document.activeElement && el.getAttribute('aria-pressed') === 'true' && el.getBoundingClientRect().height > 8), true);
      assert.equal(controls.url(), 'http://budget.test/', 'Month remains on this page');
      await controls.close();
    }
    const noSelected = await open(390, 'light');
    await noSelected.evaluate(() => {
      const rows = [...document.querySelectorAll('ol[data-bad-timeline] > li')];
      // Omit only the current publication in this adapter fixture; retain
      // future rows so the timeline exists but has no selected period.
      rows.filter(row => row.getAttribute('data-bad-timeline-role') === 'current').forEach(row => row.remove());
      document.querySelector('.g-river-wrap')?.remove();
      document.querySelector('[data-budget-bento]')?.removeAttribute('data-blend-ready');
      document.getElementById('operating-surface-body').appendChild(document.createTextNode(''));
    });
    await settle(noSelected);
    assert.equal(await noSelected.locator('.playhead-pill').evaluate(el => {
      const box = el.getBoundingClientRect();
      return el.tagName === 'DIV' && box.width > 8 && box.height > 8 && box.left >= 0 && box.right <= innerWidth;
    }), true, 'No selected point retains the plain visible native date label');
    assert.equal(await noSelected.locator('.playhead-beam').isVisible(), false);
    assert.equal(await noSelected.locator('.playhead-orb').isVisible(), false);
    await openPeriodFigures(noSelected);
    await noSelected.keyboard.press('Escape');
    assert.equal(await noSelected.locator('[data-blend-figures-open]').evaluate(el => el === document.activeElement), true);
    await noSelected.close();

    const responsive = await open(390, 'light');
    const grocery = '.blend-ring[data-blend-cat="groceries"]';
    for (const closeWith of ['button', 'Escape']) {
      await responsive.locator(grocery).focus();
      await responsive.keyboard.press('Enter');
      await responsive.locator('[data-budget-detail-sheet][open]').waitFor({ state: 'visible' });
      for (const width of [1440, 390]) {
        await responsive.setViewportSize({ width, height: 1000 });
        await settle(responsive);
        await assertBoardOrder(responsive, 'dialog resize ' + width, width);
        assert.equal(await responsive.locator('[data-budget-detail-sheet]').evaluate(el => el.open), true);
        await assertDialogPlacement(responsive, 'Grocery dialog after resize to ' + width + ' before ' + closeWith);
      }
      if (closeWith === 'button') await responsive.getByRole('button', { name: 'Close details', exact: true }).click();
      else await responsive.keyboard.press('Escape');
      await responsive.waitForFunction(selector => {
        const ring = document.querySelector(selector);
        const box = ring?.getBoundingClientRect();
        return ring === document.activeElement && ring?.getAttribute('aria-expanded') === 'false'
          && !document.querySelector('[data-budget-detail-sheet]')?.open
          && box.width > 8 && box.height > 8 && getComputedStyle(ring).visibility !== 'hidden';
      }, grocery);
      await settle(responsive);
      assert.equal(await responsive.locator(grocery).evaluate(el => el === document.activeElement), true,
        'Same visible category retains focus after ' + closeWith);
    }
    await responsive.close();

    // The approved header is the Bills opener. Exercise the native evidence
    // nodes and their handlers through the new presentation, including nested
    // Back. No payment or confirmation action is invoked.
    for (const width of [1440, 390]) {
      const detailsPage = await open(width, 'light');
      const header = detailsPage.getByRole('button', { name: 'Bills detail', exact: true });
      const panel = detailsPage.locator('[data-blend-bills-panel]');
      const originalPanel = await panel.elementHandle();
      const originalHydro = await detailsPage.locator('[data-bill-detail]:has(> [data-period-bill="hydro"])').elementHandle();
      assert.ok(originalPanel && originalHydro, 'Fixture retains original Bills and Hydro evidence');
      const originalBillCopy = await originalHydro.textContent();
      await header.scrollIntoViewIfNeeded();
      await header.focus();
      assert.equal(await header.evaluate(node => {
        const box = node.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return node === document.activeElement && !!node.closest('.blend-bills-head')
          && box.width > 8 && box.height > 8 && (hit === node || node.contains(hit));
      }), true, 'Bills header is visibly focused and hit-testable at ' + width);
      await detailsPage.keyboard.press('Enter');
      const dialog = detailsPage.locator('[data-budget-detail-sheet]');
      await dialog.waitFor({ state: 'visible' });
      await assertDialogPlacement(detailsPage, 'Bills at ' + width);
      assert.equal(await originalPanel.evaluate(node => node.closest('dialog')?.open && !node.hidden), true,
        'Bills opens the original evidence panel');
      assert.equal(await dialog.locator('[data-budget-detail-title]').innerText(), 'Bills');
      const unpaid = panel.locator('[data-budget-bill-filter="check"]');
      await unpaid.focus();
      await detailsPage.keyboard.press('Space');
      assert.equal(await unpaid.getAttribute('aria-pressed'), 'true');
      assert.equal(await panel.locator('[data-budget-bill-bucket="paid"]').isVisible(), false);
      assert.equal(await panel.locator('[data-budget-bill-bucket="check"]').isVisible(), true);
      assert.match(await panel.locator('[data-budget-bill-filter-status]').textContent(), /bills to confirm/);
      const hydro = panel.locator('[data-budget-bill-open="hydro"]');
      const originalHydroOpener = await hydro.elementHandle();
      await hydro.focus();
      await detailsPage.keyboard.press('Enter');
      await detailsPage.waitForFunction(() => document.querySelector('[data-budget-detail-title]')?.textContent === 'Hydro');
      await assertDialogPlacement(detailsPage, 'Nested Hydro at ' + width);
      assert.equal(await originalHydro.evaluate(node => node.closest('dialog')?.open && !node.hidden), true,
        'Hydro opens the original occurrence evidence');
      assert.equal(await originalHydro.textContent(), originalBillCopy, 'Opening preserves the published bill evidence');
      assert.match(await dialog.locator('[data-budget-detail-body]').innerText(), /Missing evidence does not mean unpaid/);
      assert.equal(await originalPanel.evaluate(node => node.hidden && node.inert), true,
        'Inactive Bills panel cannot remain in the nested focus order');
      await dialog.getByRole('button', { name: 'Go back', exact: true }).click();
      await detailsPage.waitForFunction(() => document.querySelector('[data-budget-detail-title]')?.textContent === 'Bills');
      assert.equal(await originalPanel.evaluate(node => node.closest('dialog')?.open && !node.hidden && !node.inert), true);
      assert.equal(await originalHydroOpener.evaluate(node => document.activeElement === node), true,
        'Nested Back returns focus to the original Hydro row');
      assert.equal(await unpaid.getAttribute('aria-pressed'), 'true', 'Back preserves the selected Bills filter');
      assert.equal(await panel.locator('[data-budget-bill-bucket="paid"]').isVisible(), false);
      await panel.locator('[data-budget-bill-filter="all"]').click();
      assert.equal(await unpaid.getAttribute('aria-pressed'), 'false');
      assert.equal(await panel.locator('[data-budget-bill-bucket="paid"]').isVisible(), true,
        'The original filter handler still clears after a nested return');
      await dialog.getByRole('button', { name: 'Close details', exact: true }).click();
      assert.equal(await header.evaluate(node => document.activeElement === node && node.getAttribute('aria-expanded') === 'false'), true);
      assert.equal(await originalPanel.evaluate(node => !node.closest('dialog') && node.hidden), true,
        'Close restores the original Bills panel to its source');
      await header.click();
      await detailsPage.keyboard.press('Escape');
      assert.equal(await header.evaluate(node => document.activeElement === node), true, 'Escape returns to the Bills header');

      // Cross the responsive breakpoint while the native bill is nested.
      // A remount may replace DOM nodes, but cannot strand the child, lose
      // its published occurrence or send Back to the page instead of Bills.
      await header.click();
      await panel.locator('[data-budget-bill-filter="check"]').click();
      assert.equal(await unpaid.getAttribute('aria-pressed'), 'true');
      await panel.locator('[data-budget-bill-open="hydro"]').click();
      for (const resizedWidth of [width === 1440 ? 390 : 1440, width]) {
        await detailsPage.setViewportSize({ width: resizedWidth, height: 1000 });
        await detailsPage.evaluate(() => App.rerender());
        await detailsPage.waitForFunction(() => {
          const sheet = document.querySelector('[data-budget-detail-sheet]');
          return sheet?.open && sheet.querySelector('[data-budget-detail-title]')?.textContent === 'Hydro'
            && !sheet.querySelector('[data-budget-detail-back]')?.hidden;
        });
        await settle(detailsPage);
        await assertDialogPlacement(detailsPage, 'Nested Hydro after resize to ' + resizedWidth);
        const occurrence = dialog.locator('[data-bill-detail]:has(> [data-period-bill="hydro"])');
        assert.equal(await occurrence.count(), 1, 'Exactly the selected occurrence remains after resize');
        assert.equal(await occurrence.textContent(), originalBillCopy, 'Resize preserves published Hydro evidence');
        assert.equal(await unpaid.getAttribute('aria-pressed'), 'true', 'Nested resize preserves the selected Bills filter');
        assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)
          && !document.activeElement.closest('[inert], [hidden]')), true, 'Nested focus remains inside active evidence');
      }
      await dialog.getByRole('button', { name: 'Go back', exact: true }).click();
      await detailsPage.waitForFunction(() => document.querySelector('[data-budget-detail-title]')?.textContent === 'Bills');
      assert.equal(await panel.locator('[data-budget-bill-open="hydro"]').evaluate(node => node === document.activeElement), true,
        'Back after responsive remount returns to the matching bill row');
      assert.equal(await unpaid.getAttribute('aria-pressed'), 'true', 'Back after remount retains To confirm');
      assert.equal(await panel.locator('[data-budget-bill-bucket="paid"]').isVisible(), false,
        'Previously selected filter still excludes paid bills after responsive restoration');
      assert.equal(await panel.locator('[data-budget-bill-bucket="check"]').isVisible(), true);
      assert.match(await panel.locator('[data-budget-bill-filter-status]').textContent(), /bills to confirm/);
      await panel.locator('[data-budget-bill-filter="all"]').click();
      assert.equal(await unpaid.getAttribute('aria-pressed'), 'false');
      assert.equal(await panel.locator('[data-budget-bill-bucket="paid"]').isVisible(), true,
        'Native filter still clears after responsive restoration');
      await detailsPage.keyboard.press('Escape');
      assert.equal(await header.evaluate(node => node === document.activeElement && node.getAttribute('aria-expanded') === 'false'), true,
        'Nested resize flow returns to the visible Bills heading');

      const figures = detailsPage.locator('[data-budget-period-info-body]');
      const originalFigures = await figures.elementHandle();
      const figureCopy = await figures.textContent();
      assert.match(figureCopy, /Private\./, 'Static provenance is retained within Period figures');
      assert.match(figureCopy, /Forecast|Balance after bills|Expected Bills balance/, 'Native figure explanations are retained');
      const result = detailsPage.locator('[data-operating-question="07"] .budget-step-summary');
      await result.scrollIntoViewIfNeeded();
      await result.focus();
      await detailsPage.keyboard.press('Enter');
      await dialog.waitFor({ state: 'visible' });
      assert.equal(await dialog.locator('[data-budget-detail-title]').innerText(), 'Period figures');
      await assertDialogPlacement(detailsPage, 'Period figures at ' + width);
      assert.equal(await originalFigures.evaluate(node => node.closest('dialog')?.open && !node.hidden), true,
        'Period figures uses the original evidence node');
      assert.equal(await originalFigures.textContent(), figureCopy, 'All original qualifiers and provenance survive opening');
      assert.equal(await dialog.locator('a[href="/records.html"]').count(), 0, 'Provenance does not add page navigation');
      assert.equal(await dialog.locator('footer').isVisible(), true, 'Retained provenance is readable in the open dialog');
      await detailsPage.keyboard.press('Escape');
      assert.equal(await result.evaluate(node => document.activeElement === node && node.getAttribute('aria-expanded') === 'false'), true,
        'Period figures dismissal returns to the visible result');

      const income = detailsPage.locator('[data-operating-question="02"] .budget-step-summary');
      const originalIncome = await detailsPage.locator('[data-operating-question="02"] .budget-step-body').elementHandle();
      const incomeCopy = await originalIncome.textContent();
      await income.scrollIntoViewIfNeeded();
      await income.focus();
      assert.equal(await income.evaluate(node => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return node.tagName === 'SUMMARY' && node === document.activeElement && box.width > 8 && box.height > 8
          && style.visibility !== 'hidden' && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
      }), true, 'Hero Income term has visible keyboard focus at ' + width);
      await detailsPage.keyboard.press('Enter');
      await dialog.waitFor({ state: 'visible' });
      assert.equal(await originalIncome.evaluate(node => node.closest('dialog')?.open), true,
        'Income opens the native published evidence');
      assert.equal(await originalIncome.textContent(), incomeCopy);
      await detailsPage.keyboard.press('Escape');
      assert.equal(await income.evaluate(node => document.activeElement === node && !document.querySelector('[data-budget-detail-sheet]')?.open), true,
        'Income dismissal returns to its visible hero term');
      assert.equal(detailsPage.url(), 'http://budget.test/', 'Evidence interactions stay on the single page');
      await detailsPage.close();
    }

    // The Savings disclosure must expose its incumbent funding evidence through
    // the visible heading, with both native button activation keys.
    for (const width of [1440, 390]) {
      const savings = await open(width, 'light');
      const heading = savings.getByRole('button', { name: 'Savings goals', exact: true });
      const panel = savings.locator('.blend-goals-panel');
      const funding = panel.locator('[data-budget-funding-section]');
      await heading.scrollIntoViewIfNeeded();
      const target = await heading.evaluate(el => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          tag: el.tagName, type: el.type, tabIndex: el.tabIndex,
          controls: el.getAttribute('aria-controls'), expanded: el.getAttribute('aria-expanded'),
          visible: box.width >= 80 && box.height >= 18 && box.left >= 0 && box.right <= innerWidth
            && box.top >= 0 && box.bottom <= innerHeight && style.visibility !== 'hidden'
            && !el.closest('[hidden], [aria-hidden="true"], [inert]'),
          hit: hit === el || el.contains(hit),
        };
      });
      assert.ok(target.tag === 'BUTTON' && target.type === 'button' && target.tabIndex >= 0
        && target.visible && target.hit, 'Savings heading is keyboard and pointer reachable at ' + width + ': ' + JSON.stringify(target));
      assert.equal(target.controls, await panel.getAttribute('id'), 'Savings heading controls its evidence disclosure');
      assert.ok(target.controls, 'Savings disclosure has a stable accessible target');
      assert.equal(target.expanded, 'false');
      assert.equal(await panel.evaluate(el => el.open), false);
      const publishedEvidence = await funding.textContent();
      assert.ok(publishedEvidence.trim(), 'Native funding evidence exists before opening');
      for (const key of ['Enter', 'Space']) {
        await heading.focus();
        await savings.keyboard.press(key);
        await savings.waitForFunction(id => {
          const disclosure = document.getElementById(id);
          const button = document.querySelector('button[aria-controls="' + CSS.escape(id) + '"]');
          return disclosure?.open && button?.getAttribute('aria-expanded') === 'true';
        }, target.controls);
        assert.equal(await funding.isVisible(), true, key + ' reveals native Savings evidence at ' + width);
        assert.equal(await funding.textContent(), publishedEvidence, key + ' preserves published funding evidence');
        const nativeTab = funding.locator('[data-budget-funding-tab][tabindex="0"]');
        await nativeTab.focus();
        assert.equal(await nativeTab.evaluate(el => el === document.activeElement
          && el.getBoundingClientRect().width > 8 && el.getBoundingClientRect().height > 8
          && getComputedStyle(el).visibility !== 'hidden'), true, 'Native funding controls remain usable');
        await savings.keyboard.press('Escape');
        await savings.waitForFunction(id => {
          const disclosure = document.getElementById(id);
          const button = document.querySelector('button[aria-controls="' + CSS.escape(id) + '"]');
          const box = button?.getBoundingClientRect();
          return disclosure && !disclosure.open && button?.getAttribute('aria-expanded') === 'false'
            && document.activeElement === button && box.width >= 80 && box.height >= 18
            && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
            && getComputedStyle(button).visibility !== 'hidden';
        }, target.controls);
        assert.equal(await funding.isVisible(), false, 'Escape collapses native Savings evidence');
        assert.equal(await heading.evaluate(el => el === document.activeElement), true,
          'Escape returns to the visible Savings heading after ' + key + ' at ' + width);
      }
      await savings.close();
    }

    const house = await open(1440, 'light');
    const prepared = await house.evaluate(() => {
      const section = document.querySelector('[data-budget-browse="spending"]');
      const rows = [...section.querySelectorAll('.budget-category-row')]
        .filter(row => row.getAttribute('data-budget-category-open') !== 'other-spending');
      const sample = rows.slice(0, 2);
      const marked = ['$80.00 over', '$12.00 over'];
      sample.forEach((row, index) => {
        row.classList.add('is-over');
        row.querySelector('.budget-category-status').textContent = marked[index];
      });
      const printed = (document.querySelector('[data-operating-question="06"] .blend-house-body .budget-browse-counts')?.textContent || '').replace(/\s+/g, ' ').trim();
      const hold = (section.querySelector('[data-budget-browse-hold]')?.textContent || '').replace(/\s+/g, ' ').trim();
      const bento = document.querySelector('[data-budget-bento]');
      bento.removeAttribute('data-blend-ready');
      bento.querySelector('[data-blend-rings]')?.remove();
      bento.querySelector('.blend-other')?.remove();
      document.getElementById('operating-surface-body').appendChild(document.createTextNode(''));
      return { printed, hold, marked: sample.map((_, index) => marked[index]) };
    });
    await house.locator('[data-blend-rings] .blend-ring.is-over').first().waitFor();
    const household = await house.evaluate(() => {
      const section = document.querySelector('[data-budget-browse="spending"]');
      const header = section.querySelector(':scope > header');
      const body = document.querySelector('[data-operating-question="06"] .budget-step-body');
      const counts = body?.querySelector('.blend-house-body .budget-browse-counts');
      const hold = header && header.querySelector('[data-budget-browse-hold]');
      const visible = el => {
        if (!el) return false;
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return box.width > 8 && box.height > 8 && style.visibility !== 'hidden' && style.display !== 'none'
          && style.position !== 'absolute' && !el.closest('details:not([open]), [hidden], [inert]');
      };
      const rows = [...section.querySelectorAll('.budget-category-row')]
        .filter(row => row.getAttribute('data-budget-category-open') !== 'other-spending');
      const rings = [...section.querySelectorAll('.blend-ring')];
      const overs = rows.map((row, index) => {
        const ring = rings[index];
        const pill = ring && ring.querySelector('.blend-over-pill');
        const sr = pill && pill.querySelector('.budget-cash-sr');
        const word = pill && [...pill.children].find(el => !el.classList.contains('budget-cash-sr'));
        return {
          status: (row.querySelector('.budget-category-status')?.textContent || '').trim(),
          over: row.classList.contains('is-over'),
          name: (row.querySelector('.budget-category-name')?.textContent || '').trim(),
          centre: (ring?.querySelector('.blend-ring-v')?.textContent || '').trim(),
          word: word ? (word.textContent || '').trim() : '',
          sr: sr ? (sr.textContent || '').trim() : '',
          srReachable: !!(sr && getComputedStyle(sr).display !== 'none' && !sr.closest('[aria-hidden="true"]')),
          onFace: !!(word && visible(word) && !pill.closest('.budget-step-body')),
        };
      }).filter(row => row.over);
      return {
        extraDisclosure: !!section.querySelector('.blend-house-panel'),
        countText: (counts?.textContent || '').replace(/\s+/g, ' ').trim(),
        countOnFace: visible(counts),
        countInHeader: !!(header && header.contains(counts)),
        countInNativeBody: !!(body && counts && body.contains(counts)),
        countVisible: visible(counts),
        countHidden: counts ? counts.getAttribute('aria-hidden') : 'missing',
        clipped: !!(counts && counts.closest('.blend-clip, [aria-hidden="true"]')),
        holdText: (hold?.textContent || '').replace(/\s+/g, ' ').trim(),
        holdAccessible: (() => {
          if (!hold?.isConnected) return false;
          for (let node = hold; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true'
              || style.display === 'none' || style.visibility === 'hidden') return false;
          }
          return true;
        })(),
        overs,
      };
    });
    const overOk = prepared.marked.length >= 1
      && household.overs.length === prepared.marked.length
      && prepared.marked.every(status => household.overs.some(row => row.status === status && row.name !== '' && row.centre === row.name && row.word === 'Over plan' && row.sr === status && row.srReachable && row.onFace));
    if (!overOk || household.countText !== prepared.printed
      || !/known categories over plan/.test(household.countText)
      || household.extraDisclosure || household.countOnFace || household.countInHeader || !household.countInNativeBody
      || household.countVisible || household.countHidden || household.clipped
      || household.holdText !== prepared.hold || !household.holdAccessible || !/\$/.test(household.holdText)) {
      errors.push(`household count ${JSON.stringify({ prepared, household })}`);
    }
    // The redundant hold stays accessible, and the native evidence action
    // must be visible and hit-testable on the Household heading.
    for (const width of [1440, 390]) {
      await house.setViewportSize({ width, height: 1000 });
      await settle(house);
      const householdInfo = house.getByRole('button', { name: 'Household spending and reserve evidence' });
      await householdInfo.scrollIntoViewIfNeeded();
      const evidenceTarget = await householdInfo.evaluate(el => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          heading: !!el.closest('[data-budget-browse="spending"] > header h2'),
          width: box.width, height: box.height,
          visible: style.display !== 'none' && style.visibility !== 'hidden'
            && !el.closest('.blend-clip, [hidden], [aria-hidden="true"], [inert]')
            && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
          hit: hit === el || el.contains(hit),
        };
      });
      assert.ok(evidenceTarget.heading && evidenceTarget.visible && evidenceTarget.hit
        && evidenceTarget.width >= 80 && evidenceTarget.height >= 18,
      'Household heading evidence is a visible hit target at ' + width + ': ' + JSON.stringify(evidenceTarget));
      await householdInfo.focus();
      assert.equal(await householdInfo.evaluate(el => el === document.activeElement), true);
      // The Still planned / From today cell is evidence now, not a tile
      // header sentence: it lives in the Household evidence body with its
      // label, amount and timing together, and the header is free of it.
      const remainingFace = await house.locator('[data-operating-question="06"] .blend-house-body .blend-house-remain').evaluate(node => {
        const label = node.querySelector(':scope > span');
        const amount = node.querySelector('[data-budget-browse-remaining]');
        const timing = node.querySelector(':scope > small');
        return {
          label: label?.textContent.trim(), amount: amount?.textContent.trim(), timing: timing?.textContent.trim(),
          sameParent: [label, amount, timing].every(el => el?.parentElement === node),
          inBody: !!node.closest('.blend-house-body'), text: node.textContent,
        };
      });
      assert.equal(remainingFace.label, 'Still planned');
      assert.equal(remainingFace.timing, 'From today');
      assert.ok(remainingFace.amount && remainingFace.sameParent && remainingFace.inBody,
        'Still planned, its published amount and From today stay together in the Household evidence body at ' + width);
      assert.doesNotMatch(remainingFace.text, /\bleft\b/i, 'Remaining amount keeps its original qualifiers without a left suffix');
      const headerSentence = await house.locator('[data-budget-browse="spending"] > header').evaluate(node =>
        node.textContent.replace(/\s+/g, ' '));
      assert.doesNotMatch(headerSentence, /Still planned|From today/,
        'the From-today sentence is gone from the tile header at ' + width + ': ' + headerSentence);
      const originalHouseBody = await house.locator('[data-operating-question="06"] .budget-step-body').elementHandle();
      const originalCount = await house.locator('[data-operating-question="06"] .blend-house-body .budget-browse-counts').elementHandle();
      const qualifierTexts = await originalHouseBody.evaluate(node => [...node.querySelectorAll('.blend-house-body')]
        .flatMap(part => [...part.children]).flatMap(part => part.matches('.budget-browse-counts') ? [...part.children] : [part])
        .map(part => part.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean));
      assert.match(qualifierTexts.join(' '), /known categories over plan/);
      await house.keyboard.press('Enter');
      await house.locator('[data-budget-detail-sheet][open]').waitFor({ state: 'visible' });
      await assertDialogPlacement(house, 'Household heading evidence at ' + width);
      assert.equal(await originalHouseBody.evaluate(node => node.closest('dialog')?.open), true,
        'Household heading opens the original Q06 evidence body');
      assert.equal(await originalCount.evaluate(node => {
        const box = node.getBoundingClientRect();
        return !!node.closest('dialog[open]') && box.width > 8 && box.height > 8
          && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[hidden], [inert], [aria-hidden="true"], .blend-clip');
      }), true, 'Original Household count is readable in the heading disclosure');
      assert.equal((await originalCount.textContent()).replace(/\s+/g, ' ').trim(), prepared.printed);
      assert.equal(await house.locator('.blend-house-body .budget-browse-counts').count(), 1, 'No duplicated Household count after repaint');
      const holdEvidence = await house.locator('[data-budget-detail-sheet] [data-budget-detail-body]').innerText();
      for (const qualifier of qualifierTexts) {
        // Content, not spacing: textContent glues inline tokens the sheet's
        // rendered innerText separates (and vice versa), so the inclusion
        // check compares with all whitespace removed on both sides. Every
        // character of the qualification must still be present.
        assert.ok(holdEvidence.replace(/\s+/g, '').includes(qualifier.replace(/\s+/g, '')),
          'Relocated Household qualification stays readable: ' + qualifier);
      }
      for (const amount of prepared.hold.match(/-?\$[\d,]+\.\d{2}/g) || []) {
        assert.ok(holdEvidence.includes(amount), 'Household Info preserves published hold/progress amount ' + amount);
      }
      await house.keyboard.press('Escape');
      await house.waitForFunction(() => {
        const button = document.querySelector('[data-budget-browse="spending"] > header h2 [data-budget-browse-evidence="06"]');
        const box = button?.getBoundingClientRect();
        return button === document.activeElement && !document.querySelector('[data-budget-detail-sheet]')?.open
          && box.width >= 80 && box.height >= 18 && getComputedStyle(button).visibility !== 'hidden';
      });
      await settle(house);
      assert.equal(await householdInfo.evaluate(el => el === document.activeElement), true,
        'Household evidence focus remains on its visible heading button at ' + width);
      assert.equal(await originalHouseBody.evaluate(node => !node.closest('dialog') && !!node.closest('[data-operating-question="06"]')), true,
        'Household dismissal restores the same native body');
    }
    const resizedHouseHeading = house.getByRole('button', { name: 'Household spending and reserve evidence' });
    const countsBeforeResize = (await house.locator('.blend-house-body .budget-browse-counts').textContent()).replace(/\s+/g, ' ').trim();
    await resizedHouseHeading.click();
    for (const width of [1440, 390]) {
      await house.setViewportSize({ width, height: 1000 });
      await house.evaluate(() => App.rerender());
      await house.waitForFunction(() => {
        const sheet = document.querySelector('[data-budget-detail-sheet]');
        return sheet?.open && sheet.querySelector('[data-budget-detail-title]')?.textContent === 'Household budget evidence'
          && sheet.querySelectorAll('.blend-house-body .budget-browse-counts').length === 1;
      });
      await assertDialogPlacement(house, 'Open Household evidence after resize to ' + width);
      const counts = house.locator('[data-budget-detail-sheet] .blend-house-body .budget-browse-counts');
      assert.equal((await counts.textContent()).replace(/\s+/g, ' ').trim(), countsBeforeResize);
      assert.equal(await counts.isVisible(), true, 'Household counts stay readable through an open resize');
      assert.equal(await house.locator('[data-budget-browse="spending"] .blend-house-panel').count(), 0,
        'Responsive restoration does not recreate the extra Household footer');
    }
    await house.keyboard.press('Escape');
    assert.equal(await resizedHouseHeading.evaluate(node => node === document.activeElement), true,
      'Open Household resize returns to the same visible heading identity');
    await house.close();

    const next = await open(1440, 'light');
    const before = await next.locator('[data-budget-window-range]').innerText();
    await moveRiver(next, 1);
    await next.waitForFunction(prev => (document.querySelector('[data-budget-window-range]')?.textContent || '') !== prev, before);
    const paydayFit = await next.evaluate(() => {
      const pay = document.querySelector('.blend-pay');
      const main = pay && pay.querySelector('.blend-pay-main');
      if (!pay || !main) return { missing: true };
      const a = pay.getBoundingClientRect(), b = main.getBoundingClientRect();
      return {
        ring: !!pay.querySelector('.blend-pay-face, .blend-pay-ring, .blend-pay-num, .blend-pay-unit, .blend-pay-date'),
        main: (main.textContent || '').trim(),
        unavailable: main.classList.contains('is-unavailable'),
        fontSize: getComputedStyle(main).fontSize,
        tileW: Math.round(a.width),
        tileH: Math.round(a.height),
      };
    });
    if (paydayFit.missing || paydayFit.ring || paydayFit.main !== 'Upcoming · 14 days' || paydayFit.unavailable || paydayFit.fontSize !== '28px' || paydayFit.tileW > 2 || paydayFit.tileH > 2) {
      errors.push(`future payday ${JSON.stringify(paydayFit)}`);
    }
    console.log('pp+1 payday ' + paydayFit.main);
    const otherPeriod = await next.evaluate(() => {
      const shown = el => !!(el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 1);
      const date = document.querySelector('.blend-pay-date');
      const face = document.querySelector('.blend-pay-face');
      const ringWord = (document.querySelector('.blend-pay-num')?.textContent || '').trim();
      const a = date && date.getBoundingClientRect();
      const b = face && face.getBoundingClientRect();
      const overlap = !!(a && b && a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1);
      const billsSection = document.querySelector('[data-budget-browse="bills"]');
      const billRows = billsSection ? billsSection.querySelectorAll('.budget-bill-row').length : -1;
      const billsFace = (document.querySelector('.blend-bills-of')?.textContent || '').trim();
      const billsDom = (billsSection?.textContent || '').replace(/\s+/g, ' ');
      const ratio = document.querySelector('[data-operating-question="02"] [data-budget-ratio="income"]');
      const bits = node => {
        const out = [];
        const walk = el => {
          if (!el) return;
          if (el.nodeType === 3) {
            const raw = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (raw) out.push(raw);
            return;
          }
          if (el.nodeType !== 1) return;
          if (el.classList.contains('blend-est') || el.classList.contains('blend-term')) return;
          for (const child of el.childNodes) walk(child);
        };
        walk(node);
        return out.join(' ');
      };
      const parts = [];
      if (ratio) {
        const actual = bits(ratio.querySelector('[data-budget-ratio-actual]'));
        if (actual) parts.push(actual);
        const ofPlanned = [...ratio.children].find(node => node.classList.contains('budget-cash-sr') && /of planned/i.test(node.textContent || ''));
        if (ofPlanned) {
          const slash = [...ratio.children].find(node => node.getAttribute('aria-hidden') === 'true' && /\//.test(node.textContent || ''));
          if (slash) parts.push(bits(slash));
          parts.push(bits(ofPlanned));
          const plan = bits(ratio.querySelector('[data-budget-ratio-plan]'));
          if (plan) parts.push(plan);
        }
      }
      const incomePrinted = parts.join(' ').replace(/\s+/g, ' ').trim();
      const incomeShown = (document.querySelector('.blend-income .blend-muted')?.textContent || '').replace(/\s+/g, ' ').trim();
      const figure = document.querySelector('[data-operating-question="07"]');
      const foot = document.querySelector('.blend-hero-foot');
      const figureGap = figure && foot ? Math.round((foot.getBoundingClientRect().top - figure.getBoundingClientRect().bottom) * 10) / 10 : null;
      return {
        cash: shown(document.querySelector('.budget-today-cash')),
        closing: shown(document.querySelector('[data-bills-closing]')),
        overlap,
        dateLine: !date || date.scrollWidth <= date.clientWidth + 1,
        dateText: date ? (date.textContent || '').trim() : '',
        ringWord,
        billRows,
        billsFace,
        billsDom,
        incomeShown,
        incomePrinted,
        figureGap,
      };
    });
    if (otherPeriod.cash || otherPeriod.closing || otherPeriod.overlap || !otherPeriod.dateLine) {
      errors.push(`other period pills ${JSON.stringify(otherPeriod)}`);
    }
    if (/^unavailable$/i.test(otherPeriod.dateText) || (otherPeriod.ringWord === 'Unavailable' && otherPeriod.dateText === 'Unavailable')) {
      errors.push(`duplicate payday unavailable ${JSON.stringify(otherPeriod)}`);
    }
    if (otherPeriod.billRows === 0 && otherPeriod.billsFace !== 'No bills assigned') {
      errors.push(`empty bills face ${JSON.stringify(otherPeriod.billsFace)}`);
    }
    if (otherPeriod.billRows === 0 && !/\$0\.00/.test(otherPeriod.billsDom || '')) {
      errors.push('empty bills period dropped the printed zero');
    }
    assert.equal(otherPeriod.incomeShown, '', 'Next period has no separate Income tile');
    if (currentFigureGap == null || otherPeriod.figureGap == null || Math.abs(otherPeriod.figureGap - currentFigureGap) > 2) {
      errors.push(`next figure gap ${otherPeriod.figureGap} current ${currentFigureGap}`);
    }
    console.log('pp+1 income ' + otherPeriod.incomeShown);
    const aug28 = await readFunding(next);
    if (aug28.faceAttr !== 'after-proposed-funding' || aug28.qualifier !== '· before proposed savings funding'
      || !/Balance After Deductions/.test(aug28.label) || !aug28.label.includes('before proposed savings funding')
      || !aug28.q07.includes('$1,675.00') || /≈/.test(aug28.valueText)
      || aug28.lineLabel !== 'Balance After Deductions' || !aug28.srHidden
      || aug28.visibleLabel !== 'After proposed savings'
      || /Balance After Deductions/.test(aug28.shown)
      || aug28.valueText !== '$1,675.00'
      || !aug28.shown.includes('$1,675.00') || /≈/.test(aug28.shown)
      || !aug28.headline.includes('$1,870.00') || aug28.headline.includes('$1,675.00')
      || aug28.trust !== 'calculated' || aug28.chip || !aug28.lineChip || aug28.clip || !aug28.lineVisible
      || aug28.fontSize !== '15px' || aug28.color !== aug28.ink || aug28.valueWrap !== 'nowrap'
      || aug28.align == null || aug28.align > 2 || !aug28.abovePills
      || aug28.gap == null || aug28.gap < 4 || aug28.gap > 12
      || !aug28.school.some(row => /School trip/.test(row) && /\$195\.00/.test(row))
      || /After Planned Savings/.test(aug28.q07 + ' ' + aug28.label)
      || !/After proposed savings/.test(aug28.shown)
      || (aug28.terms || []).some(row => row.doubled)) {
      errors.push(`Aug 28 funding ${JSON.stringify(aug28)}`);
    }
    console.log('Aug 28 hero ' + JSON.stringify({
      range: aug28.range,
      terms: aug28.terms,
      shown: aug28.shown,
      visibleLabel: aug28.visibleLabel,
      lineLabel: aug28.lineLabel,
      headline: aug28.headline,
    }));
    await capture(next, 'budget-blend-1440-light-next.png');
    await capture(next, 'budget-blend-1440-light-aug28.png');
    const rings = await next.evaluate(() => {
      const mount = document.getElementById('operating-surface-body');
      const bento = document.querySelector('[data-budget-bento]');
      const row = document.querySelector('[data-budget-category-open="groceries"][data-budget-browse-origin="spending"]');
      row.classList.add('is-over');
      row.querySelector('.budget-category-status').textContent = '$80.00 over';
      bento.removeAttribute('data-blend-ready');
      bento.querySelector('[data-blend-rings]')?.remove();
      bento.querySelector('.blend-other')?.remove();
      mount.appendChild(document.createTextNode(''));
      return new Promise(resolve => requestAnimationFrame(() => resolve(true)));
    });
    if (!rings) errors.push('ring repaint did not run');
    await next.locator('.blend-ring.is-over').waitFor();
    const marked = await next.evaluate(() => {
      const ring = document.querySelector('.blend-ring.is-over');
      const pill = ring && ring.querySelector('.blend-over-pill');
      const sr = pill && pill.querySelector('.budget-cash-sr');
      const word = pill && [...pill.children].find(el => !el.classList.contains('budget-cash-sr'));
      const sheet = document.querySelector('[data-budget-detail-sheet]');
      return {
        centre: ring ? (ring.querySelector('.blend-ring-v')?.textContent || '') : '',
        centreName: (() => { const id = ring?.getAttribute('data-blend-cat'); const src = id && document.querySelector('[data-budget-category-open="' + CSS.escape(id) + '"]'); return (src?.querySelector('.budget-category-name')?.textContent || '').trim(); })(),
        word: word ? word.textContent : '',
        sr: sr ? sr.textContent : '',
        srReachable: !!(sr && getComputedStyle(sr).display !== 'none' && !sr.closest('[aria-hidden="true"]')),
        visible: !!(word && word.getBoundingClientRect().width > 8 && word.getBoundingClientRect().height > 8),
        popup: ring && ring.getAttribute('aria-haspopup'),
        controls: ring && ring.getAttribute('aria-controls'),
        sheetLabel: sheet && sheet.getAttribute('aria-labelledby'),
        expanded: ring && ring.getAttribute('aria-expanded'),
      };
    });
    if (!marked.centreName || marked.centre !== marked.centreName || marked.word !== 'Over plan' || marked.sr !== '$80.00 over' || !marked.srReachable || !marked.visible || marked.popup !== 'dialog'
      || marked.controls !== 'budget-detail-sheet' || marked.sheetLabel !== 'budget-detail-title') {
      errors.push(`over ring ${JSON.stringify(marked)}`);
    }
    const ring = next.locator('.blend-ring.is-over');
    await ring.focus();
    const focusRing = await ring.evaluate(el => {
      const s = getComputedStyle(el);
      return { outline: s.outlineStyle, width: parseFloat(s.outlineWidth), active: el === document.activeElement };
    });
    if (!focusRing.active || focusRing.outline === 'none' || focusRing.width < 2) {
      errors.push(`ring focus ${JSON.stringify(focusRing)}`);
    }
    await next.keyboard.press('Enter');
    await next.locator('[data-budget-detail-sheet]').waitFor({ state: 'visible' });
    const opened = await next.evaluate(() => {
      const dialog = document.querySelector('[data-budget-detail-sheet]');
      const title = document.getElementById('budget-detail-title');
      return {
        open: !!(dialog && dialog.open),
        name: title ? title.textContent : '',
        expanded: document.querySelector('.blend-ring.is-over')?.getAttribute('aria-expanded'),
      };
    });
    if (!opened.open || !opened.name || opened.expanded !== 'true') errors.push(`ring sheet ${JSON.stringify(opened)}`);
    await next.keyboard.press('Escape');
    const returnedCategory = await ring.getAttribute('data-blend-cat');
    const returned = await next.waitForFunction(category => {
      const active = document.activeElement;
      const box = active?.getBoundingClientRect();
      return active?.matches('.blend-ring') && active.getAttribute('data-blend-cat') === category
        && active.getAttribute('aria-expanded') === 'false' && box.width > 8 && box.height > 8
        && getComputedStyle(active).visibility !== 'hidden' && !document.querySelector('[data-budget-detail-sheet]')?.open;
    }, returnedCategory).then(() => true).catch(() => false);
    if (!returned) errors.push('ring focus did not return to the ring');
    await next.close();

    const stepForward = async page => {
      const before = await page.locator('[data-budget-window-range]').innerText();
      await moveRiver(page, 1);
      await page.waitForFunction(prev => (document.querySelector('[data-budget-window-range]')?.textContent || '') !== prev, before);
    };
    const sep = await open(1440, 'light');
    await stepForward(sep);
    await stepForward(sep);
    const sep11 = await readFunding(sep);
    if (!/Sep 11/.test(sep11.range) || sep11.faceAttr !== 'after-proposed-funding'
      || sep11.qualifier !== '· before proposed savings funding'
      || !sep11.label.includes('before proposed savings funding')
      || !sep11.q07.includes('$0.00') || /≈/.test(sep11.valueText)
      || sep11.lineLabel !== 'Balance After Deductions' || !sep11.srHidden
      || sep11.visibleLabel !== 'After proposed savings'
      || /Balance After Deductions/.test(sep11.shown)
      || sep11.valueText !== '$0.00'
      || !sep11.shown.includes('$0.00') || /≈/.test(sep11.shown)
      || !sep11.headline.includes('$205.00') || sep11.headline.includes('$0.00')
      || sep11.clip || !sep11.lineVisible || !sep11.lineChip
      || sep11.fontSize !== '15px' || sep11.valueWrap !== 'nowrap'
      || /After Planned Savings/.test(sep11.q07 + ' ' + sep11.label)
      || !/After proposed savings/.test(sep11.shown)) {
      errors.push(`Sep 11 funding ${JSON.stringify(sep11)}`);
    }
    console.log('Sep 11 trusts ' + JSON.stringify({
      range: sep11.range,
      shown: sep11.shown,
      visibleLabel: sep11.visibleLabel,
      terms: sep11.terms,
    }));
    await sep.close();
    const augNarrow = await open(320, 'light');
    await stepForward(augNarrow);
    const aug320 = await readFunding(augNarrow);
    if (!/Aug 28/.test(aug320.range) || aug320.qualifier !== '· before proposed savings funding'
      || !aug320.q07.includes('$1,675.00') || /≈/.test(aug320.valueText)
      || aug320.lineLabel !== 'Balance After Deductions' || !aug320.srHidden
      || aug320.visibleLabel !== 'After proposed savings'
      || /Balance After Deductions/.test(aug320.shown)
      || aug320.valueText !== '$1,675.00'
      || !aug320.shown.includes('$1,675.00') || /≈/.test(aug320.shown)
      || !aug320.headline.includes('$1,870.00') || aug320.clip || !aug320.lineVisible
      || aug320.fontSize !== '13px' || aug320.valueWrap !== 'nowrap' || !aug320.labelInside
      || aug320.align == null || aug320.align > 2) {
      errors.push(`Aug 28 narrow funding ${JSON.stringify(aug320)}`);
    }
    await capture(augNarrow, 'budget-blend-320-light-aug28.png');
    await augNarrow.close();
    const augPhone = await open(390, 'light');
    await stepForward(augPhone);
    const aug390 = await readFunding(augPhone);
    if (!/Aug 28/.test(aug390.range) || aug390.qualifier !== '· before proposed savings funding'
      || aug390.lineLabel !== 'Balance After Deductions' || !aug390.srHidden
      || aug390.visibleLabel !== 'After proposed savings'
      || /Balance After Deductions/.test(aug390.shown)
      || /≈/.test(aug390.shown) || !aug390.shown.includes('$1,675.00')
      || !aug390.headline.includes('$1,870.00') || !aug390.lineVisible
      || aug390.fontSize !== '13px') {
      errors.push(`Aug 28 phone funding ${JSON.stringify(aug390)}`);
    }
    await capture(augPhone, 'budget-blend-390-light-next.png');
    await augPhone.close();

    const closedPage = await open(1440, 'light');
    await stepForward(closedPage);
    const closedResult = await closedPage.evaluate(() => {
      const q07 = document.querySelector('[data-operating-question="07"]');
      const value = q07 && q07.querySelector('.budget-step-value');
      const bad = value && value.querySelector('.blend-bad');
      const face = document.querySelector('[data-bad-terms]')?.getAttribute('data-bad-terms-face') || '';
      if (!q07 || !value || !bad || face !== 'after-proposed-funding') {
        return { ready: false, face, hasStep: !!q07, hasValue: !!value, hasBad: !!bad };
      }
      q07.setAttribute('data-budget-result-trust', 'unavailable');
      q07.querySelectorAll('[data-budget-result-amount]').forEach(node => node.remove());
      const span = document.createElement('span');
      span.setAttribute('data-budget-result-amount', '');
      span.textContent = ' \n\t ';
      q07.appendChild(span);
      value.querySelector('.blend-after-funding')?.remove();
      let clip = value.querySelector(':scope > .blend-clip');
      if (!clip) {
        clip = document.createElement('span');
        clip.className = 'blend-clip';
        value.appendChild(clip);
      }
      while (clip.firstChild) clip.removeChild(clip.firstChild);
      clip.appendChild(document.createTextNode(' '));
      const bento = q07.closest('[data-budget-bento]');
      const hero = document.createElement('div');
      hero.className = 'budget-period-result';
      hero.setAttribute('data-budget-period-result', '');
      hero.setAttribute('data-budget-result-trust', 'unavailable');
      const heroValue = document.createElement('p');
      heroValue.className = 'budget-period-result-value';
      const heroSpan = document.createElement('span');
      heroSpan.setAttribute('data-budget-result-amount', '');
      heroSpan.textContent = '   ';
      heroValue.appendChild(heroSpan);
      hero.appendChild(heroValue);
      bento.appendChild(hero);
      bento.removeAttribute('data-blend-ready');
      document.getElementById('operating-surface-body').appendChild(document.createTextNode(''));
      return new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const stepText = (q07.innerText || '').replace(/\s+/g, ' ').trim();
          const stepRaw = q07.textContent || '';
          const finalText = (hero.innerText || '').replace(/\s+/g, ' ').trim();
          const finalRaw = hero.textContent || '';
          const after = value.querySelector('.blend-after-value');
          resolve({
            ready: true,
            after: after ? after.textContent : null,
            stepText,
            finalText,
            stepZero: stepText.includes('$0.00') || stepRaw.includes('$0.00'),
            finalZero: finalText.includes('$0.00') || finalRaw.includes('$0.00'),
            stepUnavailable: stepText.includes('Unavailable'),
            finalUnavailable: finalText.includes('Unavailable'),
            chip: !!value.querySelector('.blend-after-funding .blend-est'),
            span: span.textContent,
            heroSpan: hero.querySelector('[data-budget-result-amount]')?.textContent ?? null,
          });
        }));
      });
    });
    if (!closedResult.ready || closedResult.after !== 'Unavailable' || !closedResult.stepUnavailable
      || !closedResult.finalUnavailable || closedResult.stepZero || closedResult.finalZero
      || closedResult.chip || /\$0\.00/.test(closedResult.stepText + closedResult.finalText)) {
      errors.push(`unavailable empty Q07 ${JSON.stringify(closedResult)}`);
    }
    await closedPage.close();

    const pastData = fx.served({ fundingHistory: 'paid' });
    const assertPast = async (page, label) => {
      const before = await page.locator('[data-budget-window-range]').innerText();
      const consoleErrors = [];
      page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
      page.on('pageerror', err => consoleErrors.push(err.message));
      await moveRiver(page, -1);
      await page.waitForFunction(prev => (document.querySelector('[data-budget-window-range]')?.textContent || '') !== prev, before);
      const pastFace = await page.evaluate(() => {
        const progress = (document.querySelector('[data-budget-window-progress]')?.textContent || '').replace(/\s+/g, ' ');
        const tile = sel => !!document.querySelector(sel);
        const centres = [...document.querySelectorAll('.blend-ring-v')].map(el => {
          const style = getComputedStyle(el);
          const well = el.closest('.blend-ring-g');
          const wellBox = well ? well.getBoundingClientRect() : null;
          const range = document.createRange();
          if (el.firstChild) range.selectNodeContents(el);
          const lines = el.firstChild ? [...range.getClientRects()] : [];
          const cx = wellBox ? wellBox.left + wellBox.width / 2 : 0;
          const cy = wellBox ? wellBox.top + wellBox.height / 2 : 0;
          const inner = wellBox ? (47.5 / 104) * Math.min(wellBox.width, wellBox.height) : 0;
          const outside = !wellBox || lines.some(rect => {
            const corners = [[rect.left, rect.top], [rect.right, rect.top], [rect.left, rect.bottom], [rect.right, rect.bottom]];
            return corners.some(([x, y]) => ((x - cx) ** 2) + ((y - cy) ** 2) > (inner + 1) ** 2);
          });
          return {
            text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
            ellipsis: style.textOverflow === 'ellipsis' || style.whiteSpace === 'nowrap'
              || (el.textContent || '').includes('…') || (el.textContent || '').includes('...'),
            clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
            outside,
            lines: lines.length,
          };
        });
        const head = document.querySelector('.blend-bills-head');
        const cal = document.querySelector('[data-blend-bill-list]');
        const toggle = document.querySelector('[data-blend-bills-open]');
        const flag = head && head.querySelector('.blend-flag');
        const calBox = cal ? cal.getBoundingClientRect() : null;
        const toggleBox = toggle ? toggle.getBoundingClientRect() : null;
        const flagBox = flag ? flag.getBoundingClientRect() : null;
        return {
          progress,
          countdown: !!document.querySelector('.blend-pay-num, .blend-pay-unit'),
          remaining: !!document.querySelector('.blend-bills-of'),
          billRows: document.querySelectorAll('[data-budget-browse="bills"] .budget-bill-row').length,
          bills: tile('[data-budget-browse="bills"] [data-blend-bill-list]'),
          house: tile('[data-budget-browse="spending"] [data-blend-rings]'),
          cards: tile('.card-movement-heading .blend-tile-ico'),
          goals: tile('[data-budget-savings-goals] .blend-tile-head'),
          income: tile('.blend-income .blend-tile-head'),
          payday: tile('.blend-pay-main'),
          paydayRing: !!document.querySelector('.blend-pay-face, .blend-pay-ring'),
          paydayMain: (document.querySelector('.blend-pay-main')?.textContent || '').trim(),
          paydaySize: (() => {
            const el = document.querySelector('.blend-pay-main');
            return el ? getComputedStyle(el).fontSize : '';
          })(),
          figureGap: (() => {
            const figure = document.querySelector('[data-operating-question="07"]');
            const foot = document.querySelector('.blend-hero-foot');
            return figure && foot ? Math.round((foot.getBoundingClientRect().top - figure.getBoundingClientRect().bottom) * 10) / 10 : null;
          })(),
          afterLine: !!document.querySelector('.blend-after-funding'),
          qualifier: (document.querySelector('.blend-bad-qualifier')?.textContent || '').trim(),
          hero: document.querySelector('[data-budget-bento]')?.getAttribute('data-blend-ready') === '1',
          centres,
          detailsInHeader: !!(toggle && toggleBox && toggleBox.width > 8 && toggleBox.height > 8 && calBox
            && toggleBox.bottom <= calBox.top + 1 && head?.contains(toggle)),
          detailsClear: !flagBox || !toggleBox || toggleBox.right <= flagBox.left - 4
            || flagBox.right <= toggleBox.left - 4 || toggleBox.top >= flagBox.bottom - 1,
          historicalNote: document.querySelector('[data-bad-historical-withheld]')?.textContent || '',
          historicalHero: document.querySelector('[data-blend-term="balanceAfterDeductions"]')?.textContent || '',
          riverValue: (document.querySelector('[data-ph-value]')?.textContent || '').trim(),
          riverOrb: document.querySelector('.playhead-orb')?.hidden === false,
          riverBeam: document.querySelector('.playhead-beam')?.hidden === false,
        };
      });
      const badCentres = (pastFace.centres || []).filter(row => row.ellipsis || row.clipped || row.outside || !row.text || row.lines < 1);
      if (!/Completed pay period/i.test(pastFace.progress) || pastFace.countdown || pastFace.remaining
        || pastFace.billRows < 1 || !pastFace.bills || !pastFace.house || !pastFace.cards
        || !pastFace.goals || pastFace.income || !pastFace.payday || pastFace.paydayRing
        || pastFace.paydayMain !== 'Completed · 14 days' || pastFace.paydaySize !== '28px'
        || pastFace.afterLine || pastFace.qualifier
        || !pastFace.hero || consoleErrors.length
        || !pastFace.centres.length || badCentres.length || !pastFace.detailsInHeader || !pastFace.detailsClear
        || pastFace.riverValue !== 'Unavailable' || !/Whole-period income, bill settlement and Household evidence/.test(pastFace.historicalNote) || pastFace.historicalHero !== 'Unavailable' || pastFace.riverOrb || pastFace.riverBeam) {
        errors.push(`${label} past period ${JSON.stringify({ pastFace, badCentres, consoleErrors })}`);
      }
      if (label === '1440' && (pastFace.figureGap == null || currentFigureGap == null || Math.abs(pastFace.figureGap - currentFigureGap) > 2)) {
        errors.push(`past figure gap ${pastFace.figureGap} current ${currentFigureGap}`);
      }
      if (label === '1440') console.log('pp-1 payday ' + pastFace.paydayMain);
      const historicalQualifier = page.locator('[data-operating-question="06"] .blend-house-body > p')
        .filter({ hasText: /Completed periods show observed spending|Missing or incomplete history/ });
      assert.equal(await historicalQualifier.count(), 1, label + ': historical spending qualification is retained once');
      const originalQualifier = await historicalQualifier.elementHandle();
      const qualification = await historicalQualifier.textContent();
      const heading = page.getByRole('button', { name: 'Household spending and reserve evidence' });
      await heading.click();
      await page.locator('[data-budget-detail-sheet][open]').waitFor({ state: 'visible' });
      await assertDialogPlacement(page, label + ': historical Household evidence');
      assert.equal(await originalQualifier.evaluate(node => {
        const box = node.getBoundingClientRect();
        return !!node.closest('dialog[open]') && box.width > 8 && box.height > 8
          && !node.closest('.blend-clip, [hidden], [aria-hidden="true"], [inert]');
      }), true, label + ': original historical qualifier is readable from the Household heading');
      assert.equal(await originalQualifier.textContent(), qualification, 'Historical qualifier is not rewritten');
      await page.keyboard.press('Escape');
      assert.equal(await heading.evaluate(node => node === document.activeElement), true,
        label + ': historical Household evidence restores heading focus');
    };
    const past = await open(1440, 'light', { data: pastData });
    await assertPast(past, '1440');
    await capture(past, 'budget-blend-1440-light-past.png');
    await past.close();
    const pastMid = await open(390, 'light', { data: pastData });
    await assertPast(pastMid, '390');
    await capture(pastMid, 'budget-blend-390-light-past.png');
    await pastMid.close();
    const pastNarrow = await open(320, 'light', { data: pastData });
    await assertPast(pastNarrow, '320');
    await capture(pastNarrow, 'budget-blend-320-light-past.png');
    await pastNarrow.close();

    // Jul 31-Aug 13: 2,600 observed payroll minus 105 assigned bill minus
    // 47.25 groceries and 19.50 fuel = 2,428.25, independently reconciled.
    const qualifiedHistory = fx.fundingHistorical('full', 'paid');
    // This synthetic receipt was represented inside a dated opening that
    // predates the completed period; an amount alone is not settlement.
    qualifiedHistory.plan.opening.priorAsOf = '2026-07-30';
    qualifiedHistory.plan.opening.representedEvents.push({ id: 'payroll', date: '2026-07-31' });
    qualifiedHistory.liveOverlay.currentPeriodActuals.representedActuals.push({
      id: 'payroll', date: '2026-07-31', actual: 2600 });
    for (const width of [1440, 390, 320]) {
      const page = await open(width, 'light', { data: qualifiedHistory });
      const before = await page.locator('[data-budget-window-range]').innerText();
      await moveRiver(page, -1);
      await page.waitForFunction(prev => document.querySelector('[data-budget-window-range]')?.textContent !== prev, before);
      assert.equal(await page.locator('[data-ph-value]').innerText(), '$2,428.25', 'Qualified historical river at ' + width);
      assert.equal((await page.locator('[data-blend-term="balanceAfterDeductions"]').textContent()).trim(), '$2,428.25', 'Qualified historical hero at ' + width);
      assert.equal(await page.locator('[data-bad-historical-withheld]').count(), 0);
      await capture(page, `budget-blend-${width}-light-past-qualified.png`);
      await page.close();
    }

    const termsPage = await open(1440, 'light');
    const repaintTerms = async () => {
      await termsPage.evaluate(() => {
        const bento = document.querySelector('[data-budget-bento]');
        bento.querySelectorAll('.blend-term, .blend-bad').forEach(node => node.remove());
        bento.querySelectorAll('.budget-step-value > .blend-est').forEach(node => node.remove());
        const value = bento.querySelector('[data-operating-question="07"] .budget-step-value');
        if (value) value.classList.remove('is-fail-closed');
        bento.removeAttribute('data-blend-ready');
        document.getElementById('operating-surface-body').appendChild(document.createTextNode(''));
      });
      await termsPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const readTerms = () => termsPage.evaluate(() => {
      const read = key => {
        const slot = document.querySelector(`[data-blend-term="${key}"]`);
        const chip = slot && slot.nextElementSibling && slot.nextElementSibling.classList.contains('blend-est')
          ? (slot.nextElementSibling.textContent || '').trim() : '';
        const style = slot ? getComputedStyle(slot) : null;
        return {
          shown: (slot?.textContent || '').replace(/\s+/g, ' ').trim(),
          chip,
          muted: !!(slot && slot.classList.contains('is-unavailable')),
          ink: style ? style.color : '',
        };
      };
      return {
        periodIncome: read('periodIncome'),
        assignedBills: read('assignedBills'),
        householdBudgetHold: read('householdBudgetHold'),
        balanceAfterDeductions: read('balanceAfterDeductions'),
      };
    });
    await termsPage.evaluate(() => {
      const put = (row, value) => {
        let amount = row.querySelector('[data-bad-term-amount]');
        if (!amount) {
          amount = document.createElement('span');
          amount.setAttribute('data-bad-term-amount', '');
          row.querySelector('[data-bad-term-value]').appendChild(amount);
        }
        amount.textContent = value;
      };
      const row = document.querySelector('[data-bad-term="periodIncome"]');
      row.setAttribute('data-bad-term-trust', 'estimated');
      put(row, '$9.00');
      const big = document.querySelector('[data-bad-term="balanceAfterDeductions"]');
      big.setAttribute('data-bad-term-trust', 'estimated');
      put(big, '$1,632.01');
    });
    await repaintTerms();
    const amountPath = await readTerms();
    const beside = await termsPage.evaluate(() => {
      const cents = document.querySelector('[data-blend-term="balanceAfterDeductions"] .blend-cents');
      const chip = document.querySelector('[data-operating-question="07"] .budget-step-value > .blend-est');
      if (!cents || !chip || chip.closest('.blend-clip')) return { missing: true };
      const a = cents.getBoundingClientRect(), b = chip.getBoundingClientRect();
      return { hidden: b.width <= 2 && b.height <= 2 && getComputedStyle(chip).overflow === 'hidden',
        title: chip.previousElementSibling?.title || '', text: (chip.textContent || '').trim() };
    });
    if (amountPath.periodIncome.shown !== '$9.00' || amountPath.periodIncome.chip !== 'est.'
      || amountPath.balanceAfterDeductions.shown !== '$1,632.01' || amountPath.balanceAfterDeductions.chip !== 'est.'
      || /estimated|≈/.test(amountPath.periodIncome.shown + amountPath.balanceAfterDeductions.shown)
      || beside.missing || beside.text !== 'est.' || !beside.hidden || !/^Estimated/.test(beside.title)) {
      errors.push(`amount est path ${JSON.stringify({ amountPath, beside })}`);
    }
    await termsPage.evaluate(() => {
      const income = document.querySelector('[data-bad-term="periodIncome"]');
      income.setAttribute('data-bad-term-trust', 'estimated');
      income.querySelector('[data-bad-term-amount]').textContent = ' \n ';
      const big = document.querySelector('[data-bad-term="balanceAfterDeductions"]');
      big.setAttribute('data-bad-term-trust', 'unavailable');
      big.querySelector('[data-bad-term-amount]').textContent = '$1,632.01';
    });
    await repaintTerms();
    const emptySpan = await readTerms();
    if (!/≈ estimated/.test(emptySpan.periodIncome.shown) || emptySpan.periodIncome.chip
      || /\$9\.00/.test(emptySpan.periodIncome.shown)
      || emptySpan.balanceAfterDeductions.shown !== 'Unavailable' || emptySpan.balanceAfterDeductions.chip
      || !emptySpan.balanceAfterDeductions.muted) {
      errors.push(`empty or unavailable amount span ${JSON.stringify(emptySpan)}`);
    }
    await termsPage.evaluate(() => {
      document.querySelector('[data-bad-term="periodIncome"] [data-bad-term-amount]')?.remove();
      document.querySelector('[data-bad-term="balanceAfterDeductions"] [data-bad-term-amount]')?.remove();
      document.querySelector('[data-bad-terms]').setAttribute('data-bad-terms-status', 'unavailable');
    });
    await repaintTerms();
    const blocked = await readTerms();
    const blockedBad = Object.values(blocked).some(row => row.shown !== 'Unavailable' || row.chip || !row.muted);
    if (blockedBad) errors.push(`unavailable block ${JSON.stringify(blocked)}`);
    await termsPage.evaluate(() => {
      const block = document.querySelector('[data-bad-terms]');
      block.setAttribute('data-bad-terms-status', 'published');
      block.querySelector('[data-bad-term="assignedBills"]').setAttribute('data-bad-term-trust', 'unavailable');
    });
    await repaintTerms();
    const one = await readTerms();
    if (one.assignedBills.shown !== 'Unavailable' || one.assignedBills.chip || !one.assignedBills.muted
      || one.householdBudgetHold.shown === 'Unavailable' || one.householdBudgetHold.muted
      || !/≈ estimated/.test(one.periodIncome.shown) || one.periodIncome.chip) {
      errors.push(`one unavailable term ${JSON.stringify(one)}`);
    }
    await termsPage.close();

    const otherPlan = await open(1440, 'light');
    const readPlan = async html => {
      await otherPlan.evaluate(source => {
        const row = document.querySelector('[data-budget-category-open="other-spending"][data-budget-browse-origin="spending"]');
        row.querySelector('.budget-category-meta').innerHTML = source;
        const mount = document.getElementById('operating-surface-body');
        const bento = document.querySelector('[data-budget-bento]');
        bento.removeAttribute('data-blend-ready');
        bento.querySelector('[data-blend-rings]')?.remove();
        mount.appendChild(document.createTextNode(''));
      }, html);
      await otherPlan.locator('.blend-ring[data-blend-cat="other-spending"]').waitFor();
      return (await otherPlan.locator('.blend-ring[data-blend-cat="other-spending"]').innerText()).replace(/\s+/g, ' ').trim();
    };
    const plainPlan = await readPlan('<span class="budget-cash-sr">Spent </span>$22.99<span aria-hidden="true"> / </span><span class="budget-cash-sr"> of planned </span>$450.00');
    const estimatedPlan = await readPlan('<span class="budget-cash-sr">Spent </span>$22.99<span aria-hidden="true"> / </span><span class="budget-cash-sr"> of planned </span><span class="est"><span aria-hidden="true">≈</span><span class="budget-cash-sr">estimated </span></span>$450.00');
    if (!/\$22\.99/.test(plainPlan) || /of planned/i.test(plainPlan)) errors.push(`other plan face ${plainPlan}`);
    if (!/\$22\.99/.test(estimatedPlan || '') || /of planned/i.test(estimatedPlan || '')) errors.push(`future other plan ${estimatedPlan}`);
    await otherPlan.close();

    const goalPage = await open(1440, 'light');
    const goalFace = await goalPage.evaluate(() => {
      const card = document.querySelector('[data-budget-savings-goals]');
      const rows = [...card.querySelectorAll('[data-budget-savings-goal]')];
      const row = rows[0];
      row.querySelector('.budget-goal-amounts').innerHTML = '<span><span class="budget-goal-amount">Unavailable</span><small>Saved</small></span><span aria-hidden="true">/</span><span><span class="budget-goal-amount">≈ $745.75</span><small>Needed</small></span>';
      const both = rows[1] || row.cloneNode(true);
      if (!rows[1]) row.after(both);
      both.querySelector('.budget-goal-amounts').innerHTML = '<span><span class="budget-goal-amount"><span class="budget-v3-est">≈<span class="budget-cash-sr"> estimated</span></span> $100.00</span><small>Saved</small></span><span aria-hidden="true">/</span><span><span class="budget-goal-amount"><span class="budget-v3-est">≈<span class="budget-cash-sr"> estimated</span></span> $3,300.00</span><small>Needed</small></span>';
      card.querySelector('[data-blend-goals]')?.remove();
      card.querySelectorAll(':scope > .blend-tile-title').forEach(node => node.remove());
      card.querySelectorAll('.blend-goals-source').forEach(node => node.classList.remove('blend-goals-source'));
      document.querySelector('[data-budget-bento]').removeAttribute('data-blend-ready');
      document.getElementById('operating-surface-body').appendChild(document.createTextNode(''));
      return new Promise(resolve => requestAnimationFrame(() => {
        const legend = [...document.querySelectorAll('.blend-goal-legend li')].map(el => (el.innerText || '').replace(/\s+/g, ' ').trim());
        const lines = [...document.querySelectorAll('.blend-goal-legend li')];
        const bothLine = lines[1] || lines[0];
        const savedLine = bothLine.querySelector('.blend-goal-saved');
        const neededLine = bothLine.querySelector('.blend-goal-needed');
        const savedStyle = savedLine ? getComputedStyle(savedLine) : null;
        const neededStyle = neededLine ? getComputedStyle(neededLine) : null;
        const mark = neededLine && neededLine.querySelector('.budget-v3-est');
        const probe = document.createElement('span');
        probe.className = 'budget-v3-est';
        probe.textContent = '≈';
        document.body.appendChild(probe);
        const markStyle = mark ? getComputedStyle(mark) : null;
        const probeStyle = getComputedStyle(probe);
        const markColor = markStyle ? markStyle.color : '';
        const lineColor = neededStyle ? neededStyle.color : '';
        const probeColor = probeStyle.color;
        probe.remove();
        resolve({
          legend,
          kept: /≈ \$745\.75/.test(card.textContent || '') && /Unavailable/.test(card.textContent || ''),
          bothText: bothLine ? (bothLine.innerText || '').replace(/\s+/g, ' ').trim() : '',
          savedText: savedLine ? (savedLine.innerText || '').replace(/\s+/g, ' ').trim() : '',
          neededText: neededLine ? (neededLine.innerText || '').replace(/\s+/g, ' ').trim() : '',
          order: !!(savedLine && neededLine && (savedLine.compareDocumentPosition(neededLine) & Node.DOCUMENT_POSITION_FOLLOWING)),
          sameSize: !!(savedStyle && neededStyle && savedStyle.fontSize === neededStyle.fontSize && savedStyle.fontWeight === neededStyle.fontWeight),
          sameColor: !!(savedStyle && neededStyle && savedStyle.color === neededStyle.color),
          estTone: !!(markColor && markColor === probeColor && lineColor && markColor !== lineColor),
          markColor,
          lineColor,
          probeColor,
          estSize: !!(markStyle && neededStyle && markStyle.fontSize === neededStyle.fontSize),
          hiddenEstimate: !/estimated|calculated/.test((legend[0] || '') + ' ' + (savedLine ? savedLine.textContent : '') + ' ' + (neededLine ? neededLine.textContent : '')),
        });
      }));
    });
    const firstGoal = goalFace.legend[0] || '';
    if (!/Needed ≈ \$745\.75/.test(firstGoal) || /Saved Unavailable/.test(firstGoal) || goalFace.legend.some(line => /Saved Unavailable/.test(line)) || !goalFace.kept) {
      errors.push(`goal needed line ${JSON.stringify(goalFace)}`);
    }
    if (goalFace.savedText !== 'Saved ≈ $100.00' || goalFace.neededText !== 'Needed ≈ $3,300.00' || !goalFace.order || !goalFace.sameSize || !goalFace.sameColor || !goalFace.estTone || !goalFace.estSize || !goalFace.hiddenEstimate) {
      errors.push(`goal line style ${JSON.stringify(goalFace)}`);
    }
    await goalPage.close();

    // ---- Savings funding bars: typed stamps -> banded continuous bars ----
    // plan.js stamps data-budget-goal-saved-amount / -required-amount on the
    // goal <li> under exactly the predicates that print the amounts; the
    // painter bands saved over the TOTAL requirement (Forecast publishes
    // `needed` as the goal's total requirement: forecast.js sums each
    // member's full need into the daily row's needed), clamped to [0, 1] —
    // green at fully funded, amber from 25% to below full, red below 25%.
    // A missing, blank, malformed or non-finite stamp, or a negative
    // requirement, stays the neutral unknown treatment (no fill, no dot or
    // dash background, never coerced to zero); a known zero requirement is
    // the distinct no-funding-required state and never divides. The
    // decorative rings and their reserved column are gone.
    const readFundingFace = page => page.evaluate(() => {
      const card = document.querySelector('[data-budget-savings-goals]');
      if (!card) return null;
      const rows = [...card.querySelectorAll('[data-budget-savings-goal]')].map(row => ({
        key: row.getAttribute('data-budget-savings-goal'),
        savedStamp: row.getAttribute('data-budget-goal-saved-amount'),
        requiredStamp: row.getAttribute('data-budget-goal-required-amount'),
        amountsText: (row.querySelector('.budget-goal-amounts')?.innerText || '').replace(/\s+/g, ' ').trim(),
      }));
      const items = [...card.querySelectorAll('.blend-goal-legend li')].map(li => {
        const bar = li.querySelector('.blend-g-bar');
        const nameEl = li.querySelector('span');
        const statusEl = li.querySelector('.blend-goal-status');
        const fill = bar ? getComputedStyle(bar, '::before') : null;
        let glyphHit = false;
        if (nameEl && statusEl) {
          const range = document.createRange();
          range.selectNodeContents(nameEl);
          const s = statusEl.getBoundingClientRect();
          glyphHit = [...range.getClientRects()].some(r => r.right > s.left + 0.5 && r.left < s.right - 0.5
            && r.bottom > s.top + 0.5 && r.top < s.bottom - 0.5);
        }
        return {
          liClass: li.className, name: (nameEl?.textContent || '').trim(),
          barClass: bar?.className || '', w: bar ? bar.style.getPropertyValue('--w') : null,
          trackW: bar ? bar.clientWidth : 0,
          fillW: fill ? parseFloat(fill.width) : 0,
          fillBg: fill ? fill.backgroundColor : '',
          barBgImage: bar ? getComputedStyle(bar).backgroundImage : '',
          bulletBg: getComputedStyle(li, '::before').backgroundColor,
          glyphHit, clipped: nameEl ? nameEl.scrollWidth > nameEl.clientWidth + 1 : false,
          savedLine: li.querySelector('.blend-goal-saved')?.innerText?.replace(/\s+/g, ' ').trim() || null,
          neededLine: li.querySelector('.blend-goal-needed')?.innerText?.replace(/\s+/g, ' ').trim() || null,
        };
      });
      return {
        rows, items,
        rings: card.querySelectorAll('.blend-goal-rings').length,
        docScrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
        cardText: (card.innerText || '').replace(/\s+/g, ' ').trim(),
      };
    });
    const expectBand = (face, name, band, w, label) => {
      const item = face?.items.find(row => row.name === name);
      if (!item) { errors.push(`${label}: no legend item for ${name}`); return null; }
      if (item.barClass !== `blend-g-bar ${band}` || item.liClass !== band) {
        errors.push(`${label}: ${name} band ${item.barClass} / li ${item.liClass}, expected ${band}`);
      }
      if (item.w !== w) errors.push(`${label}: ${name} --w ${JSON.stringify(item.w)}, expected ${JSON.stringify(w)}`);
      if (item.barBgImage !== 'none') errors.push(`${label}: ${name} bar background image ${item.barBgImage} (dot/dash treatment must be gone)`);
      return item;
    };
    const clubGoal = 'Invented club costs', homeGoal = 'Invented annual home cost';
    const bandFills = { light: {}, dark: {} };

    // Fixture modes on the real consumer path (390, both themes for ready).
    const fbReady = await open(390, 'light', { data: dailyConsumerData('ready') });
    const readyFace = await readFundingFace(fbReady);
    const readyStamps = Object.fromEntries((readyFace?.rows || []).map(row => [row.key, [row.savedStamp, row.requiredStamp]]));
    if (JSON.stringify(readyStamps) !== JSON.stringify({ 'group:club': ['95', '230'], 'yearly-bill:home-cost': ['24', '24'] })) {
      errors.push(`funding ready stamps ${JSON.stringify(readyStamps)}`);
    }
    expectBand(readyFace, clubGoal, 'is-amber', '0.4130', 'funding ready');
    // The $24/$24 full-funding case: before this change the painter's
    // saved/(saved+needed) formula painted exactly 0.5000 here.
    const readyHome = expectBand(readyFace, homeGoal, 'is-full', '1.0000', 'funding ready $24/$24');
    if (readyHome && Math.abs(readyHome.fillW - readyHome.trackW) > 1.5) {
      errors.push(`funding ready $24/$24 fill ${readyHome.fillW}px vs track ${readyHome.trackW}px`);
    }
    const readyClub = readyFace?.items.find(row => row.name === clubGoal);
    if (readyClub?.savedLine !== 'Saved $95.00' || readyClub?.neededLine !== 'Needed $230.00') {
      errors.push(`funding ready printed lines ${JSON.stringify(readyClub)}`);
    }
    if (readyFace?.rings !== 0) errors.push(`funding ready rings nodes ${readyFace?.rings}`);
    bandFills.light.full = readyHome?.fillBg; bandFills.light.amber = readyClub?.fillBg;
    await capture(fbReady, 'funding-bars-ready-390-light.png');
    await fbReady.close();

    const fbModes = [
      ['partial', clubGoal, 'is-amber', '0.5435'],
      ['full', clubGoal, 'is-amber', '0.7609'],
      ['fully-backed', clubGoal, 'is-full', '1.0000'],
    ];
    for (const [mode, name, band, w] of fbModes) {
      const page = await open(390, 'light', { data: dailyConsumerData(mode) });
      const face = await readFundingFace(page);
      expectBand(face, name, band, w, `funding ${mode}`);
      if (face?.rings !== 0) errors.push(`funding ${mode} rings nodes ${face?.rings}`);
      await page.close();
    }

    // Ranged need: no point requirement exists, so the required stamp is
    // omitted and the bar stays neutral; the printed range text is intact.
    const fbRanged = await open(390, 'light', { data: dailyConsumerData('ranged-need') });
    const rangedFace = await readFundingFace(fbRanged);
    const rangedClubRow = rangedFace?.rows.find(row => row.key === 'group:club');
    if (rangedClubRow?.requiredStamp !== null) {
      errors.push(`funding ranged-need required stamp ${JSON.stringify(rangedClubRow)}`);
    }
    if (!/\$230\.00/.test(rangedClubRow?.amountsText || '') || !/\$250\.00/.test(rangedClubRow?.amountsText || '')) {
      errors.push(`funding ranged-need printed range ${JSON.stringify(rangedClubRow)}`);
    }
    const rangedClub = expectBand(rangedFace, clubGoal, 'is-unknown', '', 'funding ranged-need');
    if (rangedClub && rangedClub.fillW !== 0) errors.push(`funding ranged-need fill ${rangedClub.fillW}px, expected 0`);
    await fbRanged.close();

    // Unavailable path: the saved side is withheld, the stamp is absent on
    // that side, bars stay neutral, and the printed Unavailable stands.
    // The accepted unavailable packet still publishes known Needed
    // amounts, so the required stamp is present on these rows — this is
    // a per-side unknown, NOT the label-only rejected-publication path
    // proven by the next case.
    const fbMissing = await open(390, 'light', { data: dailyConsumerData('missing-stock') });
    const missingFace = await readFundingFace(fbMissing);
    if (!missingFace?.items.length) errors.push('funding missing-stock: no legend items');
    for (const item of missingFace?.items || []) {
      if (item.barClass !== 'blend-g-bar is-unknown' || item.w !== '' || item.fillW !== 0 || item.barBgImage !== 'none') {
        errors.push(`funding missing-stock bar ${JSON.stringify(item)}`);
      }
    }
    if (!/Unavailable/.test(missingFace?.cardText || '')) errors.push('funding missing-stock: Unavailable wording lost');
    await fbMissing.close();

    // Rejected publication: the served plan carries no allocation
    // policy, so Forecast publishes no sealed savings packet for the
    // page to select — Forecast.savingsFundingPublication returns null
    // and plan.js substitutes the unavailable packet (source
    // Budget.savingsDailyFundingUnavailable, no rows). The goal rows
    // then render label-only from the roster: NO saved or required
    // stamp on either row (contrast missing-stock above, whose accepted
    // packet retains known Needed amounts and the required stamp),
    // both printed amounts Unavailable, and the bars stay neutral.
    const rejectedData = dailyConsumerData('ready');
    delete rejectedData.plan.savingsEarmarks.allocationPolicy;
    const fbRejected = await open(390, 'light', { data: rejectedData });
    const rejectedFace = await readFundingFace(fbRejected);
    if (!rejectedFace?.rows.length) errors.push('funding rejected-publication: no label-only rows');
    for (const row of rejectedFace?.rows || []) {
      if (row.savedStamp !== null || row.requiredStamp !== null) {
        errors.push(`funding rejected-publication stamps ${JSON.stringify(row)}`);
      }
      if (!/Unavailable/.test(row.amountsText || '')) {
        errors.push(`funding rejected-publication amounts ${JSON.stringify(row)}`);
      }
    }
    for (const item of rejectedFace?.items || []) {
      if (item.barClass !== 'blend-g-bar is-unknown' || item.w !== '' || item.fillW !== 0 || item.barBgImage !== 'none') {
        errors.push(`funding rejected-publication bar ${JSON.stringify(item)}`);
      }
    }
    await capture(fbRejected, 'funding-bars-rejected-publication-390-light.png');
    await fbRejected.close();

    // Red band and the known-zero bar, from observed-pool tweaks of the
    // same fixture (pool 10: club lands at 34/230 red; home at a trusted
    // 0/24 — a known empty bar, red at --w 0, never the unknown treatment).
    const poolTweak = value => data => {
      data.plan.savingsPoolObservation.accounts[0].value = value;
      data.plan.startingCash.breakdown[2].value = value;
      return data;
    };
    const fbRed = await open(390, 'light', { data: poolTweak(10)(dailyConsumerData('ready')) });
    const redFace = await readFundingFace(fbRed);
    expectBand(redFace, clubGoal, 'is-red', '0.1478', 'funding red');
    const redZero = expectBand(redFace, homeGoal, 'is-red', '0.0000', 'funding known zero');
    if (redZero && redZero.fillW !== 0) errors.push(`funding known zero fill ${redZero.fillW}px, expected 0`);
    bandFills.light.red = redFace?.items.find(row => row.name === clubGoal)?.fillBg;
    await capture(fbRed, 'funding-bars-red-390-light.png');
    await fbRed.close();

    // Zero required (both commitments at 0, pool at 0): both stamps are the
    // known value 0 and the state is no-funding-required — full-width
    // neutral fill, no --w (no division), distinct from unknown.
    const zeroReqData = dailyConsumerData('ready');
    zeroReqData.plan.commitments[0].amount = 0;
    zeroReqData.plan.commitments[1].amount = 0;
    poolTweak(0)(zeroReqData);
    const fbZeroReq = await open(390, 'light', { data: zeroReqData });
    const zeroReqFace = await readFundingFace(fbZeroReq);
    const zeroReqRow = zeroReqFace?.rows.find(row => row.key === 'group:club');
    if (zeroReqRow?.savedStamp !== '0' || zeroReqRow?.requiredStamp !== '0') {
      errors.push(`funding zero-required stamps ${JSON.stringify(zeroReqRow)}`);
    }
    const zeroReq = expectBand(zeroReqFace, clubGoal, 'is-no-funding-required', '', 'funding zero-required');
    if (zeroReq && Math.abs(zeroReq.fillW - zeroReq.trackW) > 1.5) {
      errors.push(`funding zero-required fill ${zeroReq.fillW}px vs track ${zeroReq.trackW}px`);
    }
    bandFills.light.none = zeroReq?.fillBg;
    await capture(fbZeroReq, 'funding-bars-zero-required-390-light.png');
    await fbZeroReq.close();

    // Dark theme: same bands, distinguishable fills, bullet matches fill.
    const fbDark = await open(390, 'dark', { data: dailyConsumerData('ready') });
    const darkFace = await readFundingFace(fbDark);
    const darkClub = expectBand(darkFace, clubGoal, 'is-amber', '0.4130', 'funding dark');
    const darkHome = expectBand(darkFace, homeGoal, 'is-full', '1.0000', 'funding dark');
    bandFills.dark.full = darkHome?.fillBg; bandFills.dark.amber = darkClub?.fillBg;
    await fbDark.close();
    const fbDarkRed = await open(390, 'dark', { data: poolTweak(10)(dailyConsumerData('ready')) });
    const darkRedFace = await readFundingFace(fbDarkRed);
    expectBand(darkRedFace, clubGoal, 'is-red', '0.1478', 'funding dark red');
    bandFills.dark.red = darkRedFace?.items.find(row => row.name === clubGoal)?.fillBg;
    await fbDarkRed.close();
    for (const theme of ['light', 'dark']) {
      const fills = bandFills[theme];
      const distinct = new Set([fills.full, fills.amber, fills.red].filter(Boolean));
      if (distinct.size !== 3) errors.push(`funding ${theme} band fills not mutually distinguishable ${JSON.stringify(fills)}`);
      if (fills.none && (fills.none === fills.full || fills.none === fills.amber || fills.none === fills.red
        || fills.none === 'rgba(0, 0, 0, 0)')) {
        errors.push(`funding ${theme} no-funding-required fill collides ${JSON.stringify(fills)}`);
      }
    }
    for (const face of [readyFace, darkFace]) {
      for (const item of face?.items || []) {
        if (item.bulletBg !== item.fillBg) {
          errors.push(`funding bullet/fill mismatch ${item.name}: ${item.bulletBg} vs ${item.fillBg}`);
        }
      }
    }

    // Geometry across widths and themes on the progressed (ready) face:
    // counts track the goals, fill width is --w x track, nothing overflows,
    // and at 320 the goal name glyphs never reach the status column (the
    // rings column used to crush the name to ~1px and overlap them).
    for (const [width, theme] of [[320, 'light'], [320, 'dark'], [390, 'light'], [390, 'dark'], [1440, 'light'], [1440, 'dark']]) {
      const page = await open(width, theme, { data: dailyConsumerData('ready') });
      const face = await readFundingFace(page);
      const label = `funding geometry ${width}/${theme}`;
      if (!face || face.items.length !== face.rows.length || face.items.length !== 2) {
        errors.push(`${label}: counts rows=${face?.rows.length} items=${face?.items.length}`);
      }
      if (face?.rings !== 0) errors.push(`${label}: rings nodes ${face?.rings}`);
      if (face && face.docScrollW > face.innerW) errors.push(`${label}: horizontal overflow ${face.docScrollW} > ${face.innerW}`);
      for (const item of face?.items || []) {
        const expected = parseFloat(item.w) * item.trackW;
        if (Math.abs(item.fillW - expected) > 1.5) {
          errors.push(`${label}: ${item.name} fill ${item.fillW}px vs --w ${item.w} x track ${item.trackW}px`);
        }
        if (width === 320 && (item.glyphHit || item.clipped)) {
          errors.push(`${label}: ${item.name} name/status overlap glyphHit=${item.glyphHit} clipped=${item.clipped}`);
        }
      }
      if (width === 320) await capture(page, `funding-bars-ready-320-${theme}.png`);
      await page.close();
    }

    // Band edges and stamp abuse, driven through the painter on a live
    // page by restamping the source row (the painter must fail closed).
    const fbEdge = await open(390, 'light', { data: dailyConsumerData('ready') });
    const runEdge = (saved, required) => fbEdge.evaluate(([s, r]) => new Promise(resolve => {
      const card = document.querySelector('[data-budget-savings-goals]');
      const row = card.querySelector('[data-budget-savings-goal]');
      if (s == null) row.removeAttribute('data-budget-goal-saved-amount');
      else row.setAttribute('data-budget-goal-saved-amount', s);
      if (r == null) row.removeAttribute('data-budget-goal-required-amount');
      else row.setAttribute('data-budget-goal-required-amount', r);
      card.querySelector('[data-blend-goals]')?.remove();
      card.querySelectorAll('.blend-goals-source').forEach(node => node.classList.remove('blend-goals-source'));
      document.querySelector('[data-budget-bento]').removeAttribute('data-blend-ready');
      document.getElementById('operating-surface-body').appendChild(document.createTextNode(''));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const li = card.querySelector('.blend-goal-legend li');
        const bar = li?.querySelector('.blend-g-bar');
        resolve({
          barClass: bar?.className || '', w: bar ? bar.style.getPropertyValue('--w') : null,
          fillW: bar ? parseFloat(getComputedStyle(bar, '::before').width) : 0,
          trackW: bar ? bar.clientWidth : 0,
        });
      }));
    }), [saved, required]);
    const edgeCases = [
      ['25', '100', 'is-amber', '0.2500'], ['24.99', '100', 'is-red', '0.2499'],
      ['100', '100', 'is-full', '1.0000'], ['99.99', '100', 'is-amber', '0.9999'],
      ['150', '100', 'is-full', '1.0000'], ['0', '100', 'is-red', '0.0000'],
      ['0', '0', 'is-no-funding-required', ''],
      ['', '100', 'is-unknown', ''], ['NaN', '100', 'is-unknown', ''],
      ['Infinity', '100', 'is-unknown', ''], ['50', '', 'is-unknown', ''],
      ['50', 'NaN', 'is-unknown', ''], ['50', 'Infinity', 'is-unknown', ''],
      ['50', '-5', 'is-unknown', ''], ['50', 'abc', 'is-unknown', ''],
      [null, '100', 'is-unknown', ''], ['50', null, 'is-unknown', ''],
    ];
    for (const [saved, required, band, w] of edgeCases) {
      const got = await runEdge(saved, required);
      if (got.barClass !== `blend-g-bar ${band}` || got.w !== w) {
        errors.push(`funding edge saved=${JSON.stringify(saved)} required=${JSON.stringify(required)}: ${JSON.stringify(got)}, expected ${band} / ${JSON.stringify(w)}`);
      }
      if (band === 'is-no-funding-required' && Math.abs(got.fillW - got.trackW) > 1.5) {
        errors.push(`funding edge zero-required fill ${got.fillW}px vs track ${got.trackW}px`);
      }
      if (band === 'is-unknown' && got.fillW !== 0) {
        errors.push(`funding edge unknown fill ${got.fillW}px, expected 0`);
      }
    }
    await fbEdge.close();

    // Legacy branch: plan.js stamps fulfilled/required under
    // budgetGoalContributionKnown, the printed labels stay
    // Fulfilled / Required this period, and the painter bands the row
    // identically (50/200 -> amber at exactly 25%).
    const fbLegacy = await open(390, 'light', { data: dailyConsumerData('ready') });
    const legacyHtml = await fbLegacy.evaluate(() => {
      const period = { id: 'legacy-period', timelineRole: 'past', start: '2026-09-01', end: '2026-09-14',
        plannedCostFunding: { items: [{ id: 'legacy-goal', label: 'Legacy goal' }], unscheduled: [] },
        budgetProgress: { source: 'Forecast.budgetPeriodProgress', asOf: '2026-09-14', currency: 'CAD',
          start: '2026-09-01', end: '2026-09-14',
          savings: { goals: [{ id: 'legacy-goal', label: 'Legacy goal', status: 'still-to-fund',
            required: { amount: 200, trust: 'calculated', completeness: 'complete' },
            fulfilled: { amount: 50, trust: 'calculated', completeness: 'complete' },
            remaining: { amount: 150, trust: 'calculated', completeness: 'complete' } }] } } };
      return budgetSavingsGoalsHtml({ plan: {}, advice: {}, asOf: '2026-09-14' }, period, null);
    });
    if (!legacyHtml.includes('data-budget-goal-saved-amount="50"') || !legacyHtml.includes('data-budget-goal-required-amount="200"')
      || !/>Fulfilled</.test(legacyHtml) || !/>Required this period</.test(legacyHtml)
      || !legacyHtml.includes('$50.00') || !legacyHtml.includes('$200.00')) {
      errors.push(`funding legacy stamps/labels ${legacyHtml.slice(0, 400)}`);
    }
    const legacyFace = await fbLegacy.evaluate(html => new Promise(resolve => {
      const card = document.querySelector('[data-budget-savings-goals]');
      const template = document.createElement('template');
      template.innerHTML = html.trim();
      card.replaceWith(template.content.firstElementChild);
      document.querySelector('[data-budget-bento]').removeAttribute('data-blend-ready');
      document.getElementById('operating-surface-body').appendChild(document.createTextNode(''));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const next = document.querySelector('[data-budget-savings-goals]');
        const li = next?.querySelector('.blend-goal-legend li');
        const bar = li?.querySelector('.blend-g-bar');
        resolve({
          barClass: bar?.className || '', w: bar ? bar.style.getPropertyValue('--w') : null,
          status: li?.querySelector('.blend-goal-status')?.innerText?.replace(/\s+/g, ' ').trim() || '',
          savedLine: !!li?.querySelector('.blend-goal-saved'),
          neededLine: !!li?.querySelector('.blend-goal-needed'),
        });
      }));
    }), legacyHtml);
    if (legacyFace.barClass !== 'blend-g-bar is-amber' || legacyFace.w !== '0.2500'
      || legacyFace.status !== 'Still to fund' || legacyFace.savedLine || legacyFace.neededLine) {
      errors.push(`funding legacy face ${JSON.stringify(legacyFace)}`);
    }
    await fbLegacy.close();

    const unavailable = await open(1440, 'light', { unavailablePlan: true });
    const unavailableDark = await open(390, 'dark', { unavailablePlan: true });
    for (const [page, file, theme] of [
      [unavailable, 'budget-blend-1440-light-unavailable.png', 'light'],
      [unavailableDark, 'budget-blend-390-dark-unavailable.png', 'dark'],
    ]) {
      const text = await page.locator('[data-budget-surface="unavailable"]').innerText();
      if (!/unavailable/i.test(text)) errors.push(`${file} hid the fail-closed wording`);
      if (!/Notes behind these numbers/.test(text) || !/Attention needed/.test(text) || !/Current plan unavailable/.test(text)) {
        errors.push(`${file} dropped fail-closed copy`);
      }
      const shell = await page.evaluate(() => {
        const head = document.querySelector('.site-head-inner');
        const themeBtn = document.querySelector('[data-blend-theme]');
        const trust = document.querySelector('.refresh-trust');
        const card = document.querySelector('.budget-surface-unavailable');
        const brand = document.querySelector('.blend-brand');
        const themeBox = themeBtn.getBoundingClientRect();
        const brandBox = brand.getBoundingClientRect();
        return {
          flex: getComputedStyle(head).display,
          nav: !!document.querySelector('.sitenav, .sitenav-household'),
          sameRow: Math.abs((brandBox.top + brandBox.height / 2) - (themeBox.top + themeBox.height / 2)) < 14 && themeBox.left > brandBox.right,
          buildShown: (() => {
            const el = document.querySelector('.running-build');
            const style = getComputedStyle(el);
            const box = el.getBoundingClientRect();
            return style.display !== 'none' && style.fontSize === '12px' && box.height > 0 && box.height < 40;
          })(),
          trustRadius: parseFloat(getComputedStyle(trust).borderRadius),
          trustShown: trust.getBoundingClientRect().height > 20,
          cardRadius: parseFloat(getComputedStyle(card).borderRadius),
        };
      });
      if (shell.flex !== 'flex' || shell.nav || !shell.sameRow || !shell.buildShown || shell.trustRadius < 16 || !shell.trustShown || shell.cardRadius < 24) {
        errors.push(`${file} shell ${JSON.stringify(shell)}`);
      }
      await capture(page, file);
      await sampleContrast(page, '[data-budget-surface="unavailable"] h2, [data-budget-surface="unavailable"] .operating-lead, [data-budget-surface="unavailable"] p', `${theme} unavailable copy`);
    }

    const focusPage = await open(1440, 'light');
    const walk = [];
    for (let i = 0; i < 18; i++) {
      await focusPage.keyboard.press('Tab');
      const step = await focusPage.evaluate(() => {
        const el = document.activeElement;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          label: el.getAttribute('aria-label') || '',
          text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90),
          outlineStyle: s.outlineStyle,
          outlineWidth: s.outlineWidth,
          outlineColor: s.outlineColor,
          box: [Math.round(r.width), Math.round(r.height)],
          visiblyUsable: r.width >= 18 && r.height >= 18 && s.visibility !== 'hidden'
            && s.display !== 'none' && Number(s.opacity) > 0
            && !el.closest('[hidden], [inert], .blend-clip')
            && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
        };
      });
      step.outlineCheckPassed = step.outlineStyle !== 'none' && parseFloat(step.outlineWidth) >= 2 && step.box[0] > 0;
      walk.push(step);
      if (!step.outlineCheckPassed) errors.push(`focus step ${i + 1} lacks its measured outline: ${JSON.stringify(step)}`);
    }
    focusWalks.push({ viewport: 1440, theme: 'light', scope: 'first 18 keyboard stops; not comprehensive accessibility clearance',
      outlinedStops: walk.filter(step => step.outlineCheckPassed).length,
      visiblyUsableTargets: walk.filter(step => step.visiblyUsable).length, steps: walk });
    const focusTargets = [
      ['[data-budget-granularity="month"]', 'budget-blend-focus-granularity.png'],
      ['[data-operating-question="02"] .budget-step-summary', 'budget-blend-focus-income.png'],
      ['[data-operating-question="07"] > details > summary', 'budget-blend-focus-result.png'],
      ['.blend-ring[data-blend-cat="groceries"]', 'budget-blend-focus-household.png'],
      ['[data-budget-goal-open]', 'budget-blend-focus-goal.png'],
    ];
    for (const [sel, file] of focusTargets) {
      if (sel === '[data-budget-granularity="month"]') await openPeriodFigures(focusPage);
      const loc = focusPage.locator(sel).first();
      if (await loc.count()) {
        await loc.focus();
        await loc.scrollIntoViewIfNeeded();
        assert.equal(await loc.evaluate(el => el === document.activeElement
          && el.getBoundingClientRect().width > 8 && el.getBoundingClientRect().height > 8
          && getComputedStyle(el).visibility !== 'hidden'), true, 'Visible focus target ' + sel);
        await focusPage.screenshot({ path: path.join(outDir, file), fullPage: false, animations: 'disabled' });
        shots.push(file);
        if (sel === '[data-budget-granularity="month"]') await focusPage.keyboard.press('Escape');
      } else errors.push(`missing focus target ${sel}`);
    }
    await focusPage.close();
    await unavailable.close();
    await unavailableDark.close();

    const cards = require('./fixtures/card-period-movements-data');
    for (const [width, theme, file] of [
      [1440, 'light', 'budget-blend-cards-1440-light.png'],
      [320, 'dark', 'budget-blend-cards-320-dark.png'],
    ]) {
      const page = await open(width, theme, { data: cards.served() });
      await assertBoardOrder(page, `cards ${width}/${theme}`, width);
      const placement = await page.evaluate(() => {
        const strip = document.querySelector('[data-budget-card-movements]');
        const tile = strip && strip.closest('.budget-blend-card-movements');
        const board = document.querySelector('.blend-board');
        const style = strip ? getComputedStyle(strip) : null;
        return {
          tile: !!tile,
          inBoard: !!(tile && board?.contains(tile)),
          border: style && style.borderTopWidth,
          background: style && style.backgroundColor,
          label: strip ? strip.getAttribute('aria-label') : '',
        };
      });
      if (!placement.tile || !placement.inBoard
        || placement.border !== '0px' || placement.background !== 'rgba(0, 0, 0, 0)'
        || placement.label !== 'Card movement in selected pay period') {
        errors.push(`card tile ${file} ${JSON.stringify(placement)}`);
      }
      const posted = await page.evaluate(() => {
        const el = document.querySelector('.blend-card-posted');
        if (!el) return 'missing';
        if (el.closest('.card-movement-heading')) return 'still-on-face';
        if (!el.closest('.card-movement-panel')) return 'not-in-panel';
        const box = el.getBoundingClientRect();
        return box.height > 8 ? 'visible-while-closed' : '';
      });
      if (posted) errors.push(`card posted note ${file} ${posted}`);
      await capture(page, file);
      await page.close();
    }

    const statusPage = await open(1440, 'light');
    const fixtureBand = await statusPage.evaluate(() => {
      const band = document.getElementById('status-band');
      const chip = document.querySelector('.blend-plan-chip');
      const note = document.querySelector('.blend-plan-note');
      const noteBox = note ? note.getBoundingClientRect() : null;
      return {
        attr: band ? band.getAttribute('data-plan-status') : 'missing-band',
        className: band ? band.className : '',
        lead: (band?.querySelector('b')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        chip: chip ? (chip.querySelector('.blend-plan-word')?.textContent || '') : '',
        note: (note?.textContent || '').trim(),
        noteInPanel: !!(note && note.closest('.blend-hero-panel')),
        noteOnFace: !!(note && note.closest('.blend-hero-top')),
        noteVisible: !!(noteBox && noteBox.height > 8 && noteBox.width > 8),
      };
    });
    console.log('fixture plan status ' + JSON.stringify(fixtureBand));
    if (!fixtureBand.attr || fixtureBand.chip || fixtureBand.note) {
      errors.push(`native whole-window identity must survive without hero additions ${JSON.stringify(fixtureBand)}`);
    }
    const repaintStatus = async statusId => {
      await statusPage.evaluate(id => {
        const band = document.getElementById('status-band');
        if (id) band.setAttribute('data-plan-status', id);
        else band.removeAttribute('data-plan-status');
        document.querySelector('[data-budget-bento]')?.removeAttribute('data-blend-ready');
        document.getElementById('operating-surface-body').appendChild(document.createTextNode(''));
      }, statusId);
      await statusPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const readChip = () => statusPage.evaluate(() => {
      const chip = document.querySelector('.blend-plan-chip');
      const word = chip && chip.querySelector('.blend-plan-word');
      const hidden = chip && chip.querySelector('.budget-cash-sr');
      const box = word ? word.getBoundingClientRect() : null;
      const style = chip ? getComputedStyle(chip) : null;
      return {
        word: word ? word.textContent : '',
        sr: hidden ? hidden.textContent : '',
        tone: chip ? ([...chip.classList].find(name => name.startsWith('is-')) || '') : '',
        visible: !!(box && box.width > 8 && box.height > 8 && style.display !== 'none'),
        dollars: chip ? /\$/.test(chip.textContent || '') : false,
      };
    });
    for (const id of ['onPlan', 'negative', 'gap', 'unfunded', 'combination', 'overrideBreach']) {
      await repaintStatus(id);
      const got = await readChip();
      if (got.word || got.visible) {
        errors.push(`whole-window plan status ${id} drew selected-period confidence ${JSON.stringify(got)}`);
      }
    }
    await repaintStatus('onPlan');
    await capture(statusPage, 'budget-blend-1440-light-on-plan.png');
    const beforeStatus = await statusPage.locator('[data-budget-window-range]').innerText();
    await moveRiver(statusPage, 1);
    await statusPage.waitForFunction(prev => (document.querySelector('[data-budget-window-range]')?.textContent || '') !== prev, beforeStatus);
    const offPeriodChip = await readChip();
    if (offPeriodChip.word || offPeriodChip.visible) errors.push(`chip on next period ${JSON.stringify(offPeriodChip)}`);
    const nextStatusRange = await statusPage.locator('[data-budget-window-range]').innerText();
    await moveRiver(statusPage, -1);
    await statusPage.waitForFunction(prev => (document.querySelector('[data-budget-window-range]')?.textContent || '') !== prev, nextStatusRange);
    for (const id of ['belowBuffer', 'infeasible', 'unavailable', 'not-a-status']) {
      await repaintStatus(id);
      const got = await readChip();
      if (got.word || got.visible) errors.push(`plan status ${id} drew a chip ${JSON.stringify(got)}`);
    }
    await repaintStatus(null);
    const missingChip = await readChip();
    if (missingChip.word || missingChip.visible) errors.push(`missing attribute drew a chip ${JSON.stringify(missingChip)}`);
    await repaintStatus('infeasible');
    await capture(statusPage, 'budget-blend-1440-light-infeasible.png');
    await statusPage.close();

    const shootPeriod = async (width, theme, file, steps) => {
      const page = await open(width, theme);
      for (let i = 0; i < steps; i += 1) {
        const before = await page.locator('[data-budget-window-range]').innerText();
        await moveRiver(page, 1);
        await page.waitForFunction(prev => (document.querySelector('[data-budget-window-range]')?.textContent || '') !== prev, before);
      }
      await capture(page, file);
      await page.close();
    };
    await shootPeriod(1440, 'dark', 'budget-blend-1440-dark-next.png', 1);
    await shootPeriod(390, 'dark', 'budget-blend-390-dark-next.png', 1);
    await shootPeriod(320, 'light', 'budget-blend-320-light-next.png', 1);
    await shootPeriod(320, 'dark', 'budget-blend-320-dark-next.png', 1);
    for (const width of [1440, 390, 320]) {
      const page = await open(width, 'dark', { data: pastData });
      await capture(page, `budget-blend-${width}-dark-past.png`);
      await page.close();
    }

    const probe = await open(1440, 'light');
    const riverProbe = await probe.evaluate(() => new Promise(resolve => {
      const bento = document.querySelector('[data-budget-bento]');
      const mount = document.getElementById('operating-surface-body');
      const displayed = document.querySelector('[data-budget-window-progress]')?.getAttribute('data-start') || '2026-08-14';
      document.querySelector('ol[data-bad-timeline]')?.remove();
      const ol = document.createElement('ol');
      ol.setAttribute('data-bad-timeline', '');
      ol.hidden = true;
      ol.setAttribute('aria-hidden', 'true');
      const row = (attrs, body) => `<li ${attrs}>${body}</li>`;
      ol.innerHTML = [
        row('data-bad-timeline-period="past-precise" data-bad-timeline-role="past" data-bad-timeline-coverage="precise" data-bad-timeline-start="2026-06-19" data-bad-timeline-end="2026-07-02" data-bad-timeline-range-label="Jun 19 - Jul 2" data-bad-term-trust="calculated" data-bad-terms-face="balance-after-deductions"', '<span data-bad-term-amount>$3,700.00</span>'),
        row('data-bad-timeline-period="past-posted" data-bad-timeline-role="past" data-bad-timeline-coverage="posted-only" data-bad-timeline-start="2026-07-03" data-bad-timeline-end="2026-07-16" data-bad-timeline-range-label="Jul 3 - Jul 16" data-bad-term-trust="estimated" data-bad-terms-face="balance-after-deductions" data-sign="negative"', '<span data-bad-term-amount>-$420.00</span>'),
        row('data-bad-timeline-period="past" data-bad-timeline-role="past" data-bad-timeline-start="2026-07-17" data-bad-timeline-end="2026-07-30" data-bad-timeline-range-label="Jul 17 – Jul 30" data-bad-term-trust="estimated" data-bad-terms-face="balance-after-deductions"', '<span class="est">≈ estimated</span> <span data-bad-term-amount>$731.83</span>'),
        row(`data-bad-timeline-period="now" data-bad-timeline-role="current" data-bad-timeline-start="${displayed}" data-bad-timeline-end="2026-08-27" data-bad-timeline-range-label="Aug 14 – Aug 27" data-bad-term-trust="unavailable" data-bad-terms-face="balance-after-deductions"`, 'Unavailable<span data-bad-term-amount> </span>'),
        row('data-bad-timeline-period="neg" data-bad-timeline-role="future" data-bad-timeline-start="2027-01-01" data-bad-timeline-end="2027-01-14" data-bad-timeline-range-label="Jan 1 – Jan 14" data-bad-term-trust="estimated" data-bad-terms-face="balance-after-deductions" data-sign="negative"', '<span class="est">≈ estimated</span> <span data-bad-term-amount>−$1,020.09</span>'),
        row('data-bad-timeline-period="nonsign" data-bad-timeline-role="future" data-bad-timeline-start="2027-01-15" data-bad-timeline-end="2027-01-28" data-bad-timeline-range-label="Jan 15 – Jan 28" data-bad-term-trust="estimated" data-bad-terms-face="balance-after-deductions"', '<span class="est">≈ estimated</span> <span data-bad-term-amount>-$10.00</span>'),
        row('data-bad-timeline-period="zero" data-bad-timeline-role="future" data-bad-timeline-start="2027-01-29" data-bad-timeline-end="2027-02-11" data-bad-timeline-range-label="Jan 29 – Feb 11" data-bad-term-trust="calculated" data-bad-terms-face="balance-after-deductions"', '<span data-bad-term-amount>$0.00</span>'),
      ].join('');
      mount.appendChild(ol);
      document.querySelector('.g-river-wrap')?.remove();
      bento.removeAttribute('data-blend-ready');
      mount.appendChild(document.createTextNode(''));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const nav = document.querySelector('[data-bad-river]');
        const nodes = [...document.querySelectorAll('.g-river-wrap .rv')];
        const months = [...document.querySelectorAll('.g-river-wrap .months span')].map(el => (el.textContent || '').replace(/\s+/g, ' ').trim());
        resolve({
          mode: nav ? nav.getAttribute('data-bad-river') : '',
          state: nav ? nav.getAttribute('data-state') : '',
          focusable: document.querySelector('.g-river-wrap .river')?.tabIndex === 0,
          labels: nodes.map(el => el.dataset.riverNativeValue),
          compactLabels: nodes.map(el => el.textContent.trim()),
          tones: nodes.map(el => el.dataset.state),
          months,
          value: (document.querySelector('[data-ph-value]')?.textContent || '').trim(),
          orbHidden: document.querySelector('.playhead-orb')?.hidden === true,
          beamHidden: document.querySelector('.playhead-beam')?.hidden === true,
          chooserVisible: !!document.querySelector('.playhead-pill')?.getClientRects().length,
          rows: document.querySelectorAll('ol[data-bad-timeline] > li').length,
        });
      }));
    }));
    const probeLabels = ['$3,700.00', '-$420.00', '$731.83', 'Unavailable', '−$1,020.09', '-$10.00', '$0.00'];
    if (riverProbe.mode !== 'printed' || riverProbe.state !== 'unknown' || !riverProbe.focusable
      || !riverProbe.orbHidden || !riverProbe.beamHidden || !riverProbe.chooserVisible
      || riverProbe.rows !== 7 || riverProbe.labels.join('|') !== probeLabels.join('|')
      || riverProbe.value !== 'Unavailable'
      || riverProbe.tones.join('|') !== 'healthy|short|healthy|unknown|short|healthy|healthy'
      || riverProbe.compactLabels.join('|') !== '$3.7k|−$420|$732|—|−$1k|−$10|$0'
      || !riverProbe.months.some(label => label.startsWith('Aug'))
      || !riverProbe.months.some(label => /Jan/.test(label) && /2027/.test(label))) {
      errors.push(`river adapter ${JSON.stringify(riverProbe)}`);
    } else {
      console.log('river adapter ' + riverProbe.labels.join(' | '));
    }

    await openPeriodFigures(probe, true);
    await probe.keyboard.press('Escape');
    assert.equal(await probe.locator('[data-blend-figures-open]').evaluate(el => el === document.activeElement), true,
      'Unavailable selected river value retains keyboard access to Period figures');
    // The adapter preserves an already-qualified native historical publication.
    // Qualification is tested at the native producer, never inferred here.
    await probe.evaluate(() => {
      const selected = document.querySelector('ol[data-bad-timeline] > [data-bad-timeline-period="now"]');
      selected.setAttribute('data-bad-timeline-role', 'past');
      selected.setAttribute('data-bad-timeline-coverage', 'precise');
      selected.setAttribute('data-bad-term-trust', 'calculated');
      selected.querySelector('[data-bad-term-amount]').textContent = '$987.65';
      document.querySelector('.g-river-wrap')?.remove();
      document.querySelector('[data-budget-bento]').removeAttribute('data-blend-ready');
      document.getElementById('operating-surface-body').appendChild(document.createTextNode(''));
    });
    await probe.waitForFunction(() => document.querySelector('[data-ph-value]')?.textContent.trim() === '$987.65');
    assert.equal(await probe.locator('.playhead-orb').isVisible(), true, 'Qualified historical value has its plotted orb');
    assert.equal(await probe.locator('.playhead-beam').isVisible(), true, 'Qualified historical value has its amount marker');
    assert.equal(await probe.locator('[data-ph-value]').innerText(), '$987.65');
    await openPeriodFigures(probe, true);
    await probe.keyboard.press('Escape');
    assert.equal(await probe.locator('[data-blend-figures-open]').evaluate(el => el === document.activeElement), true,
      'Withheld historical value retains native period selection');
    await probe.close();

    const householdPacket = householdAll.packet();
    for (const [width, file] of [[1440, 'budget-blend-1440-light-household-all.png'], [390, 'budget-blend-390-light-household-all.png'], [320, 'budget-blend-320-light-household-all.png']]) {
      const page = await open(width, 'light', { data: householdPacket });
      await assertBoardOrder(page, `all categories ${width}`, width);
      const rings = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-budget-browse="spending"] .budget-category-row')];
        const other = rows.filter(row => row.getAttribute('data-budget-category-open') === 'other-spending');
        const names = [...document.querySelectorAll('[data-blend-rings] .blend-ring-l')].map(el => (el.textContent || '').trim());
        const printedNames = rows.filter(row => !other.includes(row)).map(row => {
          // The centre carries the published name, except the two
          // personal rings whose VISUAL centre is exactly the
          // approved short label (Systems Review 5482743628).
          const id = row.getAttribute('data-budget-category-open');
          if (id === 'dale-guilt-free') return 'Dale';
          if (id === 'amanda-guilt-free') return 'Amanda';
          return row.querySelector('.budget-category-name')?.textContent.trim();
        });
        const shownNames = [...document.querySelectorAll('[data-blend-rings] .blend-ring-v')].map(el => el.textContent.trim());
        const wells = [...document.querySelectorAll('[data-blend-rings] .blend-ring-g')].map(el => Math.round(el.getBoundingClientRect().width));
        const tops = [...document.querySelectorAll('[data-blend-rings] .blend-ring')].map(el => Math.round(el.getBoundingClientRect().top));
        const perRow = tops.filter(top => Math.abs(top - tops[0]) < 8).length;
        const more = document.querySelector('.blend-rings-more');
        const otherRing = document.querySelector('.blend-ring[data-blend-cat="other-spending"]');
        const otherNames = other.map(row => row.querySelector('.budget-category-name')?.textContent.trim());
        const foot = otherRing;
        const footBox = foot?.getBoundingClientRect();
        const children = [...(foot?.children || [])];
        const boxes = children.map(el => el.getBoundingClientRect());
        const otherFits = !!footBox && children.every((el, i) => boxes[i].left >= footBox.left - 1
          && boxes[i].right <= footBox.right + 1 && el.scrollWidth <= el.clientWidth + 1);
        const otherOverlap = boxes.some((a, i) => boxes.slice(i + 1).some(b =>
          a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1));
        return { printed: rows.length - other.length, names, printedNames, shownNames, otherNames, wells, perRow, more: !!more, otherRow: !!otherRing, otherFits, otherOverlap };
      });
      assert.deepEqual(rings.shownNames, [...rings.printedNames, ...rings.otherNames], 'Every published Household line is visible in its original order at ' + width);
      assert.ok(rings.otherFits && !rings.otherOverlap, 'Other Spending ring content fits without overlap at ' + width);
      if (rings.printed < 7 || rings.names.length !== rings.printed + rings.otherNames.length || rings.more || !rings.otherRow) {
        errors.push(`household-all ${width} ${JSON.stringify(rings)}`);
      }
      if (width >= 1000 && rings.wells.some(size => size < 96)) {
        errors.push(`household-all ring width ${JSON.stringify(rings.wells)}`);
      }
      if (width >= 1000 && rings.perRow !== 3) {
        errors.push(`household-all columns ${rings.perRow}`);
      }
      if (width <= 400 && rings.perRow !== 3) errors.push(`household-all phone columns ${rings.perRow}`);
      console.log(`household-all ${width} rings ${rings.names.length} per row ${rings.perRow}`);
      await capture(page, file);
      await page.close();
    }

    const sideScript = `
from PIL import Image
import sys
pairs = sys.argv[1:]
def fit_width(im, w):
    if im.width == w:
        return im
    h = max(1, int(round(im.height * w / im.width)))
    return im.resize((w, h), Image.Resampling.LANCZOS)
for i in range(0, len(pairs), 3):
    left, right, out = pairs[i:i+3]
    a = Image.open(left).convert('RGB')
    b = fit_width(Image.open(right).convert('RGB'), a.width)
    canvas = Image.new('RGB', (a.width + b.width + 12, max(a.height, b.height)), (236, 238, 242))
    canvas.paste(a, (0, 0))
    canvas.paste(b, (a.width + 12, 0))
    canvas.save(out)
    print(out, a.size, b.size)
`;
    // Only an explicitly supplied folder of the approved owner references may
    // serve as the visual comparison target. Prototype ZIP shots are not a fallback.
    const referenceDir = process.env.APPROVED_REFERENCE_DIR
      ? path.resolve(process.env.APPROVED_REFERENCE_DIR) : null;
    const references = [
      { key: 'desktopLight', file: 'desktop-light.png', sedimentFileId: 'file_00000000abe481f5857186c409c435a2', expectedSha256: 'd2a7bbcf95381b2018960219801592e26a608ab741b33b7ebab9b3827a7bf4f6', dimensions: [2880, 2846] },
      { key: 'desktopDark', file: 'desktop-dark.png', sedimentFileId: 'file_000000000aa481f5af2b4e6576471c55', expectedSha256: '72170f4bb71d9cae0d7194e4eb85de19437316b12695c5be57932b51c442e39f', dimensions: [2880, 1800] },
      { key: 'mobileLight', file: 'mobile-light.png', sedimentFileId: 'file_00000000da6c820c8903938c22abe5f5', expectedSha256: '42f01c091b4c4148fb5d75eb1a40fb5eff79fb2e8159a9947caa9c61700d02ac', dimensions: [780, 4238] },
    ].map(ref => {
      const file = referenceDir && path.join(referenceDir, ref.file);
      const available = !!file && fs.existsSync(file);
      const sha256 = available ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
      return { ...ref, path: file, available, sha256, matchesApproved: sha256 === ref.expectedSha256 };
    });
    const visualComparison = {
      authority: 'Owner-approved Slack images',
      sourceThread: 'C0C6M5Z1LF8/thread1791497896.975019',
      references,
      status: 'unavailable',
      darkCoverage: 'Reference cuts off inside Bills/Household; lower dark details are unproven.',
      visualMatchApproved: false,
    };
    const python = process.env.PYTHON || 'python3';
    if (!referenceDir || references.some(ref => !ref.available || !ref.matchesApproved)) {
      errors.push('Visual comparison unavailable: APPROVED_REFERENCE_DIR must contain the exact approved desktop-light.png, desktop-dark.png and mobile-light.png bytes; files are missing or their SHA-256 differs.');
    } else {
    const ref = key => references.find(item => item.key === key).path;
    const side = spawnSync(python, ['-c', sideScript,
      ref('desktopLight'), path.join(outDir, 'budget-blend-1440-light.png'), path.join(outDir, 'side-1440-light.png'),
      ref('desktopDark'), path.join(outDir, 'budget-blend-1440-dark.png'), path.join(outDir, 'side-1440-dark.png'),
      ref('mobileLight'), path.join(outDir, 'budget-blend-390-light.png'), path.join(outDir, 'side-390-light.png'),
      ref('desktopLight'), path.join(outDir, 'budget-blend-1440-light-household-all.png'), path.join(outDir, 'side-1440-light-household-all.png'),
      ref('mobileLight'), path.join(outDir, 'budget-blend-390-light-household-all.png'), path.join(outDir, 'side-390-light-household-all.png'),
    ], { encoding: 'utf8' });
    if (side.status !== 0) errors.push(`side-by-side ${side.error?.message || side.stderr || side.stdout}`);
    else {
      visualComparison.status = 'generated-requires-owner-review';
      console.log(side.stdout.trim());
    }
    }
    const crop = spawnSync(python, ['-c', `
from PIL import Image
im = Image.open(${JSON.stringify(path.join(outDir, 'budget-blend-390-light.png'))})
mid = im.height // 2
im.crop((0, 0, im.width, mid)).save(${JSON.stringify(path.join(outDir, 'budget-blend-390-light-top.png'))})
im.crop((0, mid, im.width, im.height)).save(${JSON.stringify(path.join(outDir, 'budget-blend-390-light-bot.png'))})
print('390 crops', im.size)
`], { encoding: 'utf8' });
    if (crop.status !== 0) errors.push(`390 crops ${crop.error?.message || crop.stderr || crop.stdout}`);
    else console.log(crop.stdout.trim());

    const failedContrast = contrasts.filter(row => row.pass === false || row.missing);
    if (failedContrast.length) errors.push(`contrast ${JSON.stringify(failedContrast)}`);
    if (external.length) errors.push(`external requests ${external.join(',')}`);

    verifySourceBinding(root, sourceBinding);
    const receipt = {
      proof: 'budget-blend-visual',
      fixture: 'test/fixtures/budget-surface-data.js',
      cardMovementFixture: 'test/fixtures/card-period-movements-data.js',
      liveSite: false,
      chrome: process.env.CHROME_PATH || null,
      reducedMotion: false,
      sourceBinding: { ...sourceBinding, unchangedAfterProof: true },
      servedSourceSha256,
      screenshots: shots,
      screenshotSha256: Object.fromEntries(shots.map(file => [file,
        createHash('sha256').update(fs.readFileSync(path.join(outDir, file))).digest('hex')])),
      sourceSha256: Object.fromEntries(['public/plan.js', 'public/budget-blend.js', 'public/budget-gface.css',
        'public/forecast.js', 'data.json', 'test/browser-budget-blend-proof.js'].map(file => [file,
        sourceBinding.files[file].sha256])),
      // Local reference paths can identify the owner. Publish reference
      // filenames and hashes; retain full paths only for this run's reads.
      visualComparison: { ...visualComparison, references: references.map(({ path: localPath, ...ref }) => ref) },
      contrasts,
      textContrastSamples: contrasts.filter(row => row.sampleType === 'visible-text').length,
      emptyContrastProbes: contrasts.filter(row => row.sampleType === 'no-visible-text').length,
      heroTerms,
      riverPort,
      panelRepairs,
      focusWalk: focusWalks[0],
      externalRequests: external,
      errors,
      figuresCopiedFromPrototype: false,
    };
    fs.writeFileSync(path.join(outDir, 'budget-blend-browser-receipt.json'), JSON.stringify(receipt, null, 2));
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exit(1);
    }
    console.log(`PASS budget blend proof: ${shots.length} screenshots, ${receipt.textContrastSamples} visible-text contrast samples; ${walk.length} outlined keyboard stops, ${focusWalks[0].visiblyUsableTargets} visibly usable targets`);
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
