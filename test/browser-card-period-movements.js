'use strict';
// Actual App.boot renders of the card-movement strip and the native Budget
// detail sheet, driven through visible controls wherever the shipped face
// offers one: real trigger clicks, the visible river slider's keyboard
// contract (ArrowRight/ArrowLeft step exactly one period), the visible
// "Today" button, and the period-figures sheet that re-homes the
// granularity toggle. Two qualifications, kept explicit:
//  - Switching period WHILE the modal sheet is open cannot be pointer- or
//    keyboard-driven: showModal makes the background inert by design. That
//    one transition is delivered through the app's own window-step control
//    (the same handler the arrows and the river invoke) and every
//    assertion is on the rendered result — sheet identity, content,
//    focus — never on the dispatch itself.
//  - The face prints no dated evidence at all: the trigger's right-hand
//    slot is the bare reported balance (or the Unavailable state word),
//    and the dated observation line lives only in the open panel, which
//    every card keeps; panel evidence is asserted from rendered text.
// The plan-unavailable pass is the actual-render regression for the
// plan-unavailable sheet host: on that branch the card/HELOC triggers used
// to render without any detail-sheet host, so clicks silently returned.
// Invented data; all network intercepted. No credentials, live accounts,
// writes or DOM financial stubs.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { chromium } = require('playwright');
const fx = require('./fixtures/card-period-movements-data');
const root = path.join(__dirname, '..');
const out = process.env.ATLAS_BUDGET_SCREENSHOTS_DIR || path.join(require('node:os').tmpdir(), 'card-period-movements');
fs.mkdirSync(out, { recursive: true });
// Source binding: a git blob SHA is a content address — sha1 of
// "blob <bytes>\0" + bytes — so every exercised source below resolves by
// content in the pushed head on GitHub, independent of commit identity.
const blobSha = file => {
  const bytes = fs.readFileSync(file);
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};
const exercisedSources = [
  'public/index.html', 'public/app.js', 'public/plan.js', 'public/forecast.js',
  'public/budget-surface.js', 'public/budget-card-movements.js', 'public/budget-blend.js',
  'public/budget-river.js', 'public/budget-blend.css', 'public/budget-surface.css',
  'public/budget-gface.css', 'public/budget-sheet-motion.css',
  'test/browser-card-period-movements.js',
  'test/fixtures/card-period-movements-data.js', 'test/fixtures/budget-surface-data.js',
];
const sourceBlobs = {};
for (const rel of exercisedSources) sourceBlobs[rel] = blobSha(path.join(root, rel));
const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const screenshots = [];
const states = [], errors = [], writes = [], external = [];
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const runtime = { node: process.version, chromium: await browser.version(), platform: process.platform };
  const boot = async (data, width, theme = 'light') => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', colorScheme: theme });
    page.setDefaultTimeout(10000);
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.origin !== 'http://cards.test') { external.push(u.origin); return route.abort(); }
      if (route.request().method() !== 'GET') writes.push(route.request().method());
      if (u.pathname === '/data.json') return route.fulfill({ json: data });
      if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
      const file = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
      return fs.existsSync(file) ? route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }) : route.fulfill({ status: 404, body: '' });
    });
    await page.goto('http://cards.test/');
    return page;
  };
  const capture = async (locator, name, meta) => {
    const file = path.join(out, name);
    await locator.page().evaluate(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
    await locator.screenshot({ path: file, animations: 'disabled' });
    screenshots.push({ file: name, ...meta });
  };
  const waitStart = (page, start) => page.waitForFunction(
    s => document.querySelector('[data-budget-card-movements]')?.getAttribute('data-card-period-start') === s,
    start, { timeout: 8000 });
  // Face measurement for the face-rows rule: computed style and geometry
  // only — grid area, size, weight, right edges, row alignment — never
  // DOM presence alone. The right slot's geometry is the point of the
  // rule, so each row's balance right edge is compared against the
  // trigger's content right edge.
  const measureFace = page => page.locator('[data-budget-card-movements] .card-movement-trigger').evaluateAll(rows => rows.map(btn => {
    const q = sel => btn.querySelector(sel);
    const bal = q('.card-movement-balance'), name = q('.card-movement-title'), chip = q('.blend-cc-chip');
    const rect = el => el.getBoundingClientRect();
    const balRect = bal ? rect(bal) : null, nameRect = name ? rect(name) : null;
    return { id: btn.getAttribute('data-budget-card-toggle'),
      title: (name?.textContent || '').replace('⌄', '').trim(),
      text: btn.innerText,
      balText: bal ? bal.textContent : null,
      balUnavailable: bal ? bal.classList.contains('is-unavailable') : null,
      balArea: bal ? getComputedStyle(bal).gridArea : null,
      balSize: bal ? getComputedStyle(bal).fontSize : null,
      balWeight: bal ? getComputedStyle(bal).fontWeight : null,
      balRight: balRect ? balRect.right : null,
      balLeft: balRect ? balRect.left : null,
      balTop: balRect ? balRect.top : null,
      nameRight: nameRect ? nameRect.right : null,
      nameTop: nameRect ? nameRect.top : null,
      contentRight: rect(btn).right - parseFloat(getComputedStyle(btn).paddingRight),
      deltaPresent: !!q('.card-movement-delta'),
      dashPresent: !!q('.blend-cc-dash'),
      qualifierPresent: !!q('.card-movement-qualifier'),
      chipNet: chip ? chip.getAttribute('data-net') : null,
      chipHue: chip ? chip.style.getPropertyValue('--h').trim() : null };
  }));
  const checkFace = (face, width, label) => {
    const byId = Object.fromEntries(face.map(r => [r.id, r]));
    // Exact face strings per card case: the balance slot prints the bare
    // published amount for every card — no 'Balance' prefix, no as-of
    // date, no source suffix — and every face name is the short
    // publication label, with the Amazon card exactly 'Amazon'.
    assert.equal(byId.travelvisa.balText, '$927.40', `${label}: Travel face is the bare amount`);
    assert.equal(byId.cashback.balText, '$2,264.20', `${label}: Cash Back face is the bare amount`);
    assert.equal(byId.tdcc.balText, '$1,100.00', `${label}: Emerald face is the bare amount`);
    assert.match(byId.triangle.balText, /^\$1,980\.00 as of [A-Z][a-z]{2} \d{1,2}$/, `${label}: Triangle face is its amount plus an as-of note (manual statement older than the page)`);
    assert.match(byId.mbna.balText, /^\$760\.00 as of Aug 8$/, `${label}: Amazon face is its amount plus an as-of note (manual statement older than the page)`);
    assert.equal(byId.mbna.title, 'Amazon', `${label}: Amazon face name is exactly Amazon`);
    assert.equal(byId.travelvisa.title, 'Travel', `${label}: Travel name unchanged`);
    assert.equal(byId.cashback.title, 'Cash Back', `${label}: Cash Back name unchanged`);
    assert.equal(byId.tdcc.title, 'Emerald', `${label}: Emerald name unchanged`);
    assert.equal(byId.triangle.title, 'Triangle', `${label}: Triangle name unchanged`);
    // Chip network and hue key on the canonical card id, per the issuer
    // facts: Travel and Cash Back are Visa, Triangle and Amazon are
    // Mastercard, Emerald carries no network mark.
    assert.equal(byId.travelvisa.chipNet, 'visa', `${label}: Travel chip is keyed Visa by id`);
    assert.equal(byId.cashback.chipNet, 'visa', `${label}: Cash Back chip is keyed Visa by id`);
    assert.equal(byId.tdcc.chipNet, null, `${label}: Emerald chip carries no network mark`);
    assert.equal(byId.triangle.chipNet, 'mc', `${label}: Triangle chip is keyed Mastercard by id`);
    assert.equal(byId.mbna.chipNet, 'mc', `${label}: Amazon chip keeps its Mastercard mark`);
    assert.equal(byId.travelvisa.chipHue, '220', `${label}: Travel chip hue by id`);
    assert.equal(byId.cashback.chipHue, '160', `${label}: Cash Back chip hue by id`);
    assert.equal(byId.tdcc.chipHue, '150', `${label}: Emerald chip hue by id`);
    assert.equal(byId.triangle.chipHue, '0', `${label}: Triangle chip hue by id`);
    assert.equal(byId.mbna.chipHue, '30', `${label}: Amazon chip hue by id`);
    for (const r of face) {
      assert.equal(r.balSize, '16px', `${label}: ${r.id} balance takes the primary size`);
      assert.equal(r.balWeight, '650', `${label}: ${r.id} balance takes the primary weight`);
      assert.equal(r.balArea, 'chg', `${label}: ${r.id} balance occupies the right slot at every width`);
      assert.ok(Math.abs(r.balRight - r.contentRight) <= 2,
        `${label}: ${r.id} balance right edge shares the trigger's content right edge (${r.balRight} vs ${r.contentRight})`);
      assert.ok(Math.abs(r.balTop - r.nameTop) <= 2,
        `${label}: ${r.id} balance shares the name's row — no second line`);
      assert.ok(r.nameRight <= r.balLeft + 1, `${label}: ${r.id} name and balance do not overlap`);
      assert.equal(r.deltaPresent, false, `${label}: ${r.id} prints no net-change delta on the face`);
      assert.equal(r.dashPresent, false, `${label}: ${r.id} prints no unavailable dash on the face`);
      assert.equal(r.qualifierPresent, false, `${label}: ${r.id} prints no net qualifier on the face`);
      assert.doesNotMatch(r.text, /Balance|Net|Manual statement|Unavailable/,
        `${label}: ${r.id} face text carries no prefix, net or provenance`);
      assert.equal(/as of/.test(r.text), ['triangle', 'mbna'].includes(r.id), `${label}: only stale manual rows carry an as-of note (${r.id})`);
    }
  };
  // The heading contract is semantic (Systems Review 5485851551 R1):
  // the region's accessible name and the actual h2 read exactly
  // 'Credit cards'. The painted .blend-tile-title alone does not prove
  // it, and no heading may keep the old 'Card movement' name.
  const checkHeadingNames = async (strip, label) => {
    const heading = strip.getByRole('heading', { name: 'Credit cards' });
    assert.equal(await heading.count(), 1, `${label}: one heading carries the accessible name Credit cards`);
    assert.equal((await heading.first().textContent()).trim(), 'Credit cards',
      `${label}: the semantic heading text is exactly Credit cards`);
    assert.equal(await strip.getByRole('heading', { name: /card movement/i }).count(), 0,
      `${label}: no heading retains the Card movement name`);
    assert.equal(await strip.getAttribute('aria-label'), 'Credit cards',
      `${label}: the region accessible name is Credit cards`);
  };
  const only = (process.env.ATLAS_PROOF_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
  const wanted = state => !only.length || only.includes(state);
  try {
    for (const width of [1440, 390, 320]) for (const state of ['complete', 'opening-missing', 'truncated', 'pending-unknown', 'credit-ambiguous'].filter(wanted)) {
      const data = fx.served();
      if (state === 'opening-missing') delete data.liveOverlay.cardPeriodBalanceEvidence.cards[0].opening;
      if (state === 'truncated') data.liveOverlay.currentPeriodActuals.transactionCoverage = 'truncated';
      if (state === 'pending-unknown') data.liveOverlay.currentPeriodActuals.pendingCoverage = 'unknown';
      if (state === 'credit-ambiguous') delete data.liveOverlay.currentPeriodActuals.transactions.find(tx => tx.id === 'payment-a').kindHint;
      const page = await boot(data, width);
      const strip = page.locator('[data-budget-card-movements]');
      await strip.waitFor();
      const travel = page.locator('[data-budget-card-toggle="travelvisa"]');
      const amazon = page.locator('[data-budget-card-toggle="mbna"]');
      assert.equal(await strip.getAttribute('data-card-period-start'), fx.START);
      assert.equal(await strip.getAttribute('data-card-period-end'), fx.END);
      assert.deepEqual(await strip.locator('[data-budget-card-toggle]').evaluateAll(rows => rows.map(row => row.getAttribute('data-budget-card-toggle'))), ['travelvisa', 'cashback', 'tdcc', 'triangle', 'mbna']);
      const contrastChecks = [];
      assert.match(await travel.innerText(), /\$927\.40/);
      assert.doesNotMatch(await travel.innerText(), /Net|↑|↓/, 'the Travel face prints no net change');
      assert.match(await page.locator('[data-budget-card-toggle="cashback"]').innerText(), /\$2,264\.20/);
      assert.match(await page.locator('[data-budget-card-toggle="tdcc"]').innerText(), /\$1,100\.00/);
      assert.equal(await amazon.locator('.card-movement-title').innerText(), 'Amazon',
        'the Amazon face name is exactly Amazon');
      assert.match(await amazon.innerText(), /\$760\.00/);
      assert.doesNotMatch(await amazon.innerText(), /Manual statement/,
        'the Amazon face carries no provenance — the dated evidence is the panel\u2019s');
      // The tile heading is exactly 'Credit cards' and no heading net
      // meta prints anywhere in the strip.
      assert.equal(await strip.locator('.blend-tile-title').innerText(), 'Credit cards',
        'the tile heading is exactly Credit cards');
      assert.equal(await strip.locator('.blend-cc-net').count(), 0, 'no heading net meta prints');
      await checkHeadingNames(strip, `${state} ${width}px light`);
      checkFace(await measureFace(page), width, `${state} ${width}px light`);
      if (state === 'complete') {
        await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
        checkFace(await measureFace(page), width, `${state} ${width}px dark`);
        await capture(strip, `${state}-strip-${width}-dark.png`, { state, width, theme: 'dark', subject: 'card strip, closed' });
        await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
        // The blend (non-gface) face restates the same rule in its own
        // columns: the balance sits in the right-hand column at primary
        // size, and no delta or dash exists on the face. Measured on
        // clones of the real triggers in a plain blend container at
        // desktop width.
        const blendFace = await page.evaluate(() => {
          const strip = document.querySelector('[data-budget-card-movements]');
          const host = document.createElement('div');
          host.className = 'budget-blend-card-movements';
          host.style.cssText = 'position:absolute;left:0;top:0;width:900px;visibility:hidden';
          for (const id of ['travelvisa', 'mbna']) host.appendChild(strip.querySelector(`[data-budget-card-toggle="${id}"]`).cloneNode(true));
          document.body.appendChild(host);
          const out = [...host.querySelectorAll('.card-movement-trigger')].map(btn => {
            const bal = btn.querySelector('.card-movement-balance');
            return { id: btn.getAttribute('data-budget-card-toggle'),
              balText: bal ? bal.textContent : null,
              balCol: bal ? getComputedStyle(bal).gridColumnStart : null, balRow: bal ? getComputedStyle(bal).gridRowStart : null,
              balSize: bal ? getComputedStyle(bal).fontSize : null, balWeight: bal ? getComputedStyle(bal).fontWeight : null,
              deltaPresent: !!btn.querySelector('.card-movement-delta'),
              dashPresent: !!btn.querySelector('.blend-cc-dash') };
          });
          host.remove();
          return out;
        });
        for (const r of blendFace) {
          assert.equal(r.balText, r.id === 'mbna' ? '$760.00 as of Aug 8' : '$927.40', `blend face: ${r.id} balance (Amazon adds its as-of note)`);
          assert.equal(r.balCol, '2', `blend face: ${r.id} balance takes the right-hand column`);
          assert.equal(r.balRow, '1', `blend face: ${r.id} balance takes the primary rows`);
          assert.equal(r.balSize, '16px', `blend face: ${r.id} balance takes the primary size`);
          assert.equal(r.balWeight, '650', `blend face: ${r.id} balance takes the primary weight`);
          assert.equal(r.deltaPresent, false, `blend face: ${r.id} prints no net-change delta`);
          assert.equal(r.dashPresent, false, `blend face: ${r.id} prints no unavailable dash`);
        }
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no viewport overflow');
      if (width < 600) {
        const list = await strip.locator('.card-movement-track').evaluate(el => {
          const style = getComputedStyle(el);
          const rows = [...el.querySelectorAll('.card-movement-trigger')];
          return {
            column: style.flexDirection === 'column',
            fits: el.scrollWidth <= el.clientWidth + 1 && rows.every(row => row.scrollWidth <= row.clientWidth + 1),
          };
        });
        assert.equal(list.column, true, 'narrow cards stay a vertical list');
        assert.equal(list.fits, true, 'narrow cards do not clip or scroll sideways');
      }
      const layout = await page.evaluate(() => {
        const strip = document.querySelector('[data-budget-card-movements]');
        const period = document.querySelector('.budget-surface-grid');
        const browse = document.querySelector('.budget-browse-grid');
        const billsClosing = document.querySelector('[data-bills-closing]');
        const style = getComputedStyle(strip);
        return { after: !period || !!(period.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING),
          before: !browse || !!(strip.compareDocumentPosition(browse) & Node.DOCUMENT_POSITION_FOLLOWING),
          billsClosingBefore: !billsClosing || !!(billsClosing.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING),
          border: style.borderTopWidth, background: style.backgroundColor };
      });
      assert.equal(layout.after, true); assert.equal(layout.before, true); assert.equal(layout.border, '0px');
      assert.equal(layout.billsClosingBefore, true, 'Bills-only primary metric retains its place above the card strip');
      assert.equal(layout.background, 'rgba(0, 0, 0, 0)', 'no large container background');
      await capture(strip, `${state}-strip-${width}-light.png`, { state, width, theme: 'light', subject: 'card strip, closed' });
      await travel.focus(); await page.keyboard.press('Enter');
      const panel = page.locator('[data-budget-card-panel="travelvisa"]');
      await panel.waitFor();
      const sheet = page.locator('[data-budget-detail-sheet]');
      assert.equal(await sheet.evaluate(el => el.open), true, 'card click opens the native detail sheet');
      assert.equal(await travel.getAttribute('aria-haspopup'), 'dialog');
      assert.equal(await travel.getAttribute('aria-controls'), await sheet.getAttribute('id'),
        'trigger controls the actual dialog');
      assert.equal(await panel.evaluate(el => el.closest('[data-budget-detail-sheet]') !== null), true,
        'panel moves into the native sheet');
      assert.equal(await strip.locator('[data-budget-card-panel="travelvisa"]').count(), 0, 'the opened panel leaves the strip for the sheet');
      assert.equal(await panel.locator('[data-card-movement-transaction]').count(), 6);
      assert.match(await panel.innerText(), /Pending authorization[\s\S]*28\.60/);
      assert.match(await panel.innerText(), /Purpose unconfirmed: payments do not automatically settle scheduled minimums; lender confirmation remains separate/);
      assert.doesNotMatch(await panel.innerText(), /purchases remain in their spending categories once/);
      assert.equal(await panel.locator('[data-card-movement-transaction="cash-leg-a"]').count(), 0, 'paired cash leg not double-counted');
      assert.match(await panel.locator('[data-card-movement-transaction="payment-a"]').innerText(), state === 'credit-ambiguous' ? /Credit · type unconfirmed/ : /household purpose unconfirmed/);
      if (state === 'complete') {
        // The Opening/Closing endpoints sit behind the panel's native
        // "Balance and payment details" disclosure, collapsed on open;
        // expanding it keeps every endpoint figure reachable verbatim.
        const balanceDetails = panel.locator('details.card-movement-details');
        assert.equal(await balanceDetails.evaluate(el => el.open), false,
          'the balance disclosure starts collapsed');
        assert.equal(await balanceDetails.locator('> summary').innerText(), 'Balance and payment details',
          'the disclosure summary label is exact');
        assert.doesNotMatch(await panel.innerText(), /\$820\.00/,
          'the opening balance stays behind the collapsed disclosure');
        await balanceDetails.locator('> summary').click();
        assert.equal(await balanceDetails.evaluate(el => el.open), true,
          'the summary expands the disclosure');
        assert.match(await panel.innerText(), /\$820\.00[\s\S]*\$927\.40/);
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          await strip.locator('.card-movement-trigger').evaluateAll(rows => Promise.all(rows.flatMap(row => row.getAnimations()).map(animation => animation.finished.catch(() => {}))));
          const contrast = await strip.locator('.card-movement-trigger .card-movement-balance:not(.is-unavailable)').evaluateAll(rows => {
            const parse = color => {
              const values = (color || '').match(/[\d.]+/g);
              if (!values) return null;
              const scale = color.startsWith('color(srgb') ? 1 : 255;
              const rgb = values.slice(0, 3).map(Number).map(value => value / scale * 255);
              const alpha = values[3] == null ? 1 : Number(values[3]);
              return { rgb, alpha };
            };
            const composite = (fg, bg) => fg.rgb.map((channel, index) => Math.round(channel * fg.alpha + bg[index] * (1 - fg.alpha)));
            const luminance = rgb => {
              const lin = rgb.map(value => {
                const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
              });
              return lin[0] * 0.2126 + lin[1] * 0.7152 + lin[2] * 0.0722;
            };
            const painted = node => {
              const layers = [];
              let current = node;
              while (current) {
                const parsed = parse(getComputedStyle(current).backgroundColor);
                if (parsed && parsed.alpha > 0) layers.push(parsed);
                current = current.parentElement;
              }
              const dark = document.documentElement.getAttribute('data-theme') === 'dark';
              let bg = dark ? [5, 5, 7] : [236, 238, 242];
              for (const layer of layers.reverse()) bg = layer.alpha >= 0.99 ? layer.rgb : composite(layer, bg);
              return bg;
            };
            return rows.map(row => {
              const foreground = luminance(parse(getComputedStyle(row).color).rgb);
              const background = luminance(painted(row));
              return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
            });
          });
          assert.ok(contrast.every(ratio => ratio >= 4.5), `${theme} balance text contrast: ${contrast}`);
          contrastChecks.push({ theme, ratios: contrast });
        }
        await capture(sheet, `complete-open-${width}-dark.png`, { state, width, theme: 'dark', subject: 'card sheet open' });
        await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
        await page.evaluate(() => App.rerender());
        assert.equal(await panel.isVisible(), true, 'rerender retains open identity with fresh publication');
        assert.equal(await panel.evaluate(el => el.closest('[data-budget-detail-sheet]') !== null), true,
          'rerender restores the same card panel into the fresh sheet');
        assert.equal(await page.evaluate(() => document.querySelector('[data-budget-detail-sheet]')?.contains(document.activeElement)), true,
          'native sheet lifecycle owns focus after rerender restore');
        await page.setViewportSize({ width: width === 1440 ? 390 : 1440, height: 1000 });
        assert.equal(await panel.isVisible(), true); assert.match(await travel.innerText(), /\$927\.40/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.setViewportSize({ width, height: 1000 });
      }
      await capture(sheet, `${state}-open-${width}-light.png`, { state, width, theme: 'light', subject: 'card sheet open' });
      await page.keyboard.press('Escape');
      assert.equal(await panel.isVisible(), false); assert.equal(await travel.evaluate(el => el === document.activeElement), true);
      await amazon.click();
      const amazonPanel = page.locator('[data-budget-card-panel="mbna"]');
      assert.match(await amazonPanel.innerText(), /Aug 8[\s\S]*Manual statement observation/);
      assert.match(await amazon.innerText(), /\$760\.00/,
        'trigger shows the bare reported balance; its provenance stays in the panel');
      assert.doesNotMatch(await amazon.innerText(), /Manual statement/);
      await page.keyboard.press('Escape');
      assert.equal(await amazonPanel.isVisible(), false);
      if (state === 'complete') {
        // The panels keep the dated evidence every face omits.
        await travel.click();
        assert.match(await panel.innerText(), /Reported balance \$927\.40 · Aug 20/,
          'Travel panel keeps the dated evidence its face omits');
        await page.keyboard.press('Escape');
        assert.equal(await panel.isVisible(), false);
        const cashback = page.locator('[data-budget-card-toggle="cashback"]');
        await cashback.click();
        const cashPanel = page.locator('[data-budget-card-panel="cashback"]');
        assert.match(await cashPanel.innerText(), /Reported balance \$2,264\.20 · Aug 20/,
          'Cash Back panel keeps the dated evidence its face omits');
        await page.keyboard.press('Escape');
        assert.equal(await cashPanel.isVisible(), false);
      }
      await travel.click();
      assert.equal(await panel.isVisible(), true);
      assert.equal(await amazonPanel.isVisible(), false);
      await page.locator('[data-budget-detail-close]').click();
      assert.equal(await panel.isVisible(), false); assert.equal(await travel.evaluate(el => el === document.activeElement), true);
      if (state === 'complete') {
        // Switching period WHILE the sheet is open. The modal dialog makes
        // the background inert, so the transition is delivered through the
        // app's own window-step control (the handler the visible arrows and
        // river invoke); the assertions below are all on rendered state.
        await travel.click();
        assert.equal(await panel.isVisible(), true);
        assert.equal(await panel.locator('[data-card-movement-transaction]').count(), 6);
        await page.evaluate(() => document.querySelector('[data-budget-window-step="1"]').click());
        await waitStart(page, '2026-08-28');
        assert.equal(await sheet.evaluate(el => el.open), true, 'sheet stays open across the period switch');
        assert.equal(await panel.isVisible(), true, 'the same card panel is restored in the new period');
        assert.equal(await panel.evaluate(el => el.closest('[data-budget-detail-sheet]') !== null), true);
        await panel.locator('details.card-movement-details > summary').click();
        assert.match(await panel.innerText(), /Future period not observed/,
          'the restored panel shows the new period qualification, not the old ledger');
        assert.equal(await panel.locator('[data-card-movement-transaction]').count(), 0,
          'the future period never borrows the current ledger');
        const futureFace = await measureFace(page);
        assert.ok(futureFace.every(r => r.balText === 'Unavailable' && r.balUnavailable === true),
          'the future period prints the unavailable state in the balance slot — no balance is borrowed or invented');
        assert.ok(futureFace.every(r => r.balArea === 'chg' && r.balSize === '12px' && r.balWeight === '500'),
          'the state word sits in the same right slot with the state typography');
        assert.ok(futureFace.every(r => Math.abs(r.balRight - r.contentRight) <= 2),
          'the state word shares the amounts’ right edge');
        assert.equal(await page.evaluate(() => document.querySelector('[data-budget-detail-sheet]')?.contains(document.activeElement)), true,
          'focus stays inside the sheet across the switch');
        await page.evaluate(() => document.querySelector('[data-budget-window-step="-1"]').click());
        await waitStart(page, fx.START);
        assert.equal(await panel.isVisible(), true, 'stepping back while open restores the current panel');
        assert.equal(await panel.locator('[data-card-movement-transaction]').count(), 6,
          'the current ledger is restored with the period');
        await page.keyboard.press('Escape');
        assert.equal(await panel.isVisible(), false);
        assert.equal(await travel.evaluate(el => el === document.activeElement), true,
          'focus returns to the card trigger after the while-open round trip');
        // Visible navigation: the river slider's own keyboard contract.
        const river = page.locator('.river[role="slider"]');
        await river.focus();
        assert.equal(await river.evaluate(el => el === document.activeElement), true, 'the river slider takes focus');
        await page.keyboard.press('ArrowRight');
        await waitStart(page, '2026-08-28');
        assert.match(await travel.innerText(), /Unavailable/);
        assert.doesNotMatch(await travel.innerText(), /Net/);
        await travel.click();
        await panel.locator('details.card-movement-details > summary').click();
        assert.match(await panel.innerText(), /Future period not observed/);
        assert.equal(await panel.locator('[data-card-movement-transaction]').count(), 0, 'future never borrows current ledger');
        await page.keyboard.press('Escape');
        assert.equal(await panel.isVisible(), false);
        const today = page.locator('[data-blend-river-today]');
        assert.equal(await today.isVisible(), true, 'the river Today button is the visible way back');
        await today.click();
        await waitStart(page, fx.START);
        assert.equal(await page.locator('[data-budget-card-panel]:not([hidden])').count(), 0, 'range change leaves no previous detail open');
        assert.match(await travel.innerText(), /\$927\.40/);
        // A past period publishes no reported balance: every row shows
        // the unavailable state in the balance slot instead.
        // and every trigger keeps today's layout exactly.
        await page.evaluate(() => document.querySelector('[data-budget-window-step="-1"]').click());
        await page.waitForFunction(s => document.querySelector('[data-budget-card-movements]')?.getAttribute('data-card-period-start') !== s,
          fx.START, { timeout: 8000 });
        const pastFace = await measureFace(page);
        assert.ok(pastFace.every(r => r.balText === 'Unavailable' && r.balUnavailable === true),
          'the past period never borrows the current reported balance');
        assert.ok(pastFace.every(r => r.balArea === 'chg' && r.balSize === '12px' && r.balWeight === '500'),
          'past-period rows show the state word in the same right slot');
        await page.evaluate(() => document.querySelector('[data-budget-window-step="1"]').click());
        await waitStart(page, fx.START);
        assert.match(await travel.innerText(), /\$927\.40/);
        // Granularity through visible controls: the period-figures sheet
        // re-homes the granularity toggle; month view is left through its
        // own visible "See the pay periods" drill button and drilldown exit.
        const figures = page.locator('[data-operating-question="07"] .budget-step-summary');
        await figures.click();
        const monthButton = page.locator('[data-budget-detail-sheet] [data-budget-granularity="month"]');
        await monthButton.waitFor();
        assert.equal(await monthButton.isVisible(), true, 'the granularity toggle is visible inside the figures sheet');
        await monthButton.click();
        await page.waitForFunction(() => document.querySelector('[data-budget-surface]')?.getAttribute('data-budget-surface') === 'month');
        assert.equal(await strip.count(), 0, 'no manufactured calendar-month net');
        const drill = page.locator('[data-budget-surface-section="month"] [data-budget-granularity="pay-period"]');
        assert.equal(await drill.isVisible(), true, 'the month view offers its own visible pay-period drill');
        await drill.click();
        const exit = page.locator('[data-budget-drilldown-exit]');
        await exit.waitFor();
        await exit.click();
        await strip.waitFor();
        assert.match(await travel.innerText(), /\$927\.40/);
      }
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
      states.push({ width, state, layout, contrastChecks, synthetic: true });
      await page.close(); console.log(`PASS ${width}px ${state}: native App.boot, exact period, all five cards, qualification and keyboard behavior`);
    }
    // Plan-unavailable branch: the sheet host must exist here too, or the
    // card/HELOC triggers render with a controller that has no dialog and
    // every click silently returns. Same served evidence; only the
    // operating plan is withheld.
    for (const width of wanted('plan-unavailable') ? [1440, 390, 320] : []) {
      const data = fx.helocServed();
      data.liveOverlay.operatingPlan = 'unavailable';
      const page = await boot(data, width);
      const strip = page.locator('[data-budget-card-movements]');
      await strip.waitFor();
      assert.equal(await page.evaluate(() => document.querySelector('[data-budget-surface]')?.getAttribute('data-budget-surface')),
        'unavailable', 'the plan-unavailable branch is the one under test');
      assert.equal(await page.locator('[data-budget-surface-section="unavailable"]').count(), 1,
        'the unavailable presentation itself is unchanged');
      assert.deepEqual(await strip.locator('[data-budget-card-toggle]').evaluateAll(rows => rows.map(row => row.getAttribute('data-budget-card-toggle'))),
        ['travelvisa', 'cashback', 'tdcc', 'triangle', 'mbna', 'heloc']);
      const puById = Object.fromEntries((await measureFace(page)).map(r => [r.id, r]));
      assert.equal(puById.heloc.balText, '$42,025.35', 'HELOC face is its bare reported balance');
      // The unavailable branch renders the strip outside the bento face,
      // so the blend furniture (chips, tile title) does not exist here —
      // the renderer's own face is what this branch proves.
      assert.equal(puById.heloc.chipNet, null, 'no blend chip is painted on the unavailable branch');
      assert.equal(puById.heloc.deltaPresent, false, 'no net delta prints on the unavailable branch');
      assert.equal(puById.mbna.balText, '$760.00 as of Aug 8', 'Amazon face is its reported balance plus the as-of note on the unavailable branch');
      // R1: on this branch the renderer's own heading is the visible
      // one (no blend furniture), so it must be the Credit cards
      // heading — semantically and visibly.
      await checkHeadingNames(strip, `${width}px plan-unavailable`);
      const puHeading = strip.locator('.card-movement-heading h2');
      assert.equal(await puHeading.isVisible(), true, 'the heading is visible on the unavailable branch');
      assert.equal((await puHeading.innerText()).trim(), 'Credit cards',
        'the visible heading on the unavailable branch is exactly Credit cards');
      const sheet = page.locator('[data-budget-detail-sheet]');
      assert.equal(await sheet.count(), 1, 'the unavailable branch renders the native sheet host');
      const travel = page.locator('[data-budget-card-toggle="travelvisa"]');
      assert.equal(await travel.getAttribute('aria-haspopup'), 'dialog');
      assert.equal(await travel.getAttribute('aria-controls'), await sheet.getAttribute('id'),
        'unavailable-branch trigger controls the actual dialog');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no viewport overflow');
      await capture(strip, `plan-unavailable-strip-${width}-light.png`, { state: 'plan-unavailable', width, theme: 'light', subject: 'card strip on the plan-unavailable branch' });
      await travel.click();
      const panel = page.locator('[data-budget-card-panel="travelvisa"]');
      assert.equal(await sheet.evaluate(el => el.open), true, 'card click opens the sheet on the unavailable branch');
      assert.equal(await panel.isVisible(), true);
      assert.equal(await panel.evaluate(el => el.closest('[data-budget-detail-sheet]') !== null), true,
        'panel moves into the native sheet on the unavailable branch');
      await panel.locator('details.card-movement-details > summary').click();
      assert.match(await panel.innerText(), /\$820\.00[\s\S]*\$927\.40/,
        'balances stay accessible while the plan is unavailable');
      assert.equal(await panel.locator('[data-card-movement-transaction]').count(), 6,
        'the ledger stays accessible while the plan is unavailable');
      await capture(sheet, `plan-unavailable-card-open-${width}-light.png`, { state: 'plan-unavailable', width, theme: 'light', subject: 'card sheet open on the plan-unavailable branch' });
      await page.locator('[data-budget-detail-close]').click();
      assert.equal(await panel.isVisible(), false);
      assert.equal(await travel.evaluate(el => el === document.activeElement), true,
        'Close returns focus to the card trigger on the unavailable branch');
      // The unavailable-branch card above is Travel; MBNA is exercised too
      // so the record names each card's evidence separately.
      const amazon = page.locator('[data-budget-card-toggle="mbna"]');
      await amazon.click();
      const amazonPanel = page.locator('[data-budget-card-panel="mbna"]');
      assert.equal(await amazonPanel.isVisible(), true, 'the MBNA card also opens on the unavailable branch');
      assert.match(await amazonPanel.innerText(), /Manual statement observation/,
        'the MBNA panel keeps its manual-statement qualification on the unavailable branch');
      assert.match(await amazon.innerText(), /\$760\.00/,
        'the MBNA trigger balance stays as published on the unavailable branch');
      assert.doesNotMatch(await amazon.innerText(), /Manual statement/);
      await page.keyboard.press('Escape');
      assert.equal(await amazonPanel.isVisible(), false);
      assert.equal(await amazon.evaluate(el => el === document.activeElement), true,
        'Escape returns focus to the MBNA trigger on the unavailable branch');
      const heloc = page.locator('[data-budget-card-toggle="heloc"]');
      await heloc.click();
      const helocPanel = page.locator('[data-budget-card-panel="heloc"]');
      assert.equal(await helocPanel.isVisible(), true, 'HELOC opens on the unavailable branch');
      assert.match(await helocPanel.innerText(), /Payments reduce the HELOC balance/);
      await page.evaluate(() => App.rerender());
      assert.equal(await helocPanel.isVisible(), true, 'rerender restores the HELOC panel on the unavailable branch');
      assert.equal(await helocPanel.evaluate(el => el.closest('[data-budget-detail-sheet]') !== null), true);
      assert.equal(await page.evaluate(() => document.querySelector('[data-budget-detail-sheet]')?.contains(document.activeElement)), true,
        'focus stays in the sheet after the unavailable-branch restore');
      if (width === 320) {
        await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
        await page.waitForTimeout(300);
        await capture(sheet, 'plan-unavailable-heloc-open-320-dark.png', { state: 'plan-unavailable', width, theme: 'dark', subject: 'HELOC sheet open on the plan-unavailable branch' });
        await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      }
      await page.keyboard.press('Escape');
      assert.equal(await helocPanel.isVisible(), false);
      assert.equal(await heloc.evaluate(el => el === document.activeElement), true,
        'Escape returns focus to the HELOC trigger on the unavailable branch');
      states.push({ width, state: 'plan-unavailable', synthetic: true });
      await page.close(); console.log(`PASS ${width}px plan-unavailable: sheet host present, card + HELOC open/close/Escape/focus and remount restore`);
    }
    // Missing-balance branch: one card's balance is genuinely absent (no
    // canonical balance and no overlay proposal), so its face row prints
    // the Unavailable state word in the same right slot the amounts use —
    // same area, same right edge, state typography — while the other
    // rows keep their bare amounts. Nothing is invented in its place.
    for (const width of wanted('balance-missing') ? [1440, 390, 320] : []) {
      const data = fx.served();
      delete data.debts.find(row => row.id === 'mbna').balance;
      data.liveOverlay.overlays = data.liveOverlay.overlays.filter(o => o.locator !== 'debts:mbna');
      const page = await boot(data, width);
      const strip = page.locator('[data-budget-card-movements]');
      await strip.waitFor();
      await checkHeadingNames(strip, `${width}px balance-missing`);
      const face = await measureFace(page);
      const byId = Object.fromEntries(face.map(r => [r.id, r]));
      assert.equal(byId.mbna.balText, 'Unavailable', `${width}px balance-missing: Amazon prints the state word`);
      assert.equal(byId.mbna.balUnavailable, true, `${width}px balance-missing: Amazon state word carries the state class`);
      assert.equal(byId.mbna.balArea, 'chg', `${width}px balance-missing: the state word occupies the right slot`);
      assert.equal(byId.mbna.balSize, '12px', `${width}px balance-missing: the state word takes the state size`);
      assert.equal(byId.mbna.balWeight, '500', `${width}px balance-missing: the state word takes the state weight`);
      assert.ok(Math.abs(byId.mbna.balRight - byId.mbna.contentRight) <= 2,
        `${width}px balance-missing: the state word shares the amounts' right edge`);
      assert.equal(byId.travelvisa.balText, '$927.40', `${width}px balance-missing: Travel keeps its amount`);
      assert.equal(byId.triangle.balText, '$1,980.00 as of Aug 17', `${width}px balance-missing: Triangle keeps its amount and its as-of note`);
      await capture(strip, `balance-missing-strip-${width}-light.png`, { state: 'balance-missing', width, theme: 'light', subject: 'card strip, one balance missing' });
      states.push({ width, state: 'balance-missing', synthetic: true });
      await page.close(); console.log(`PASS ${width}px balance-missing: state word in the right slot, other rows unchanged`);
    }
    // Ready-review P2 4251469063: prove the browser's computed button name,
    // including balance meaning and the unchanged full-label action. DOM
    // presence alone does not prove this accessible-name contract.
    for (const width of wanted('accessible-balance') ? [1440, 320] : []) {
      for (const theme of ['light', 'dark']) for (const [mode, amount, expected] of [
        ['numeric', 760, '$760.00'], ['unavailable', null, 'Unavailable'],
        ['zero', 0, '$0.00'], ['negative', -25.50, '\u2212$25.50'],
      ]) {
        const data = fx.served();
        const debt = data.debts.find(row => row.id === 'mbna');
        if (amount === null) {
          delete debt.balance;
          data.liveOverlay.overlays = data.liveOverlay.overlays.filter(o => o.locator !== 'debts:mbna');
        } else {
          debt.balance = amount;
          data.liveOverlay.overlays.find(o => o.locator === 'debts:mbna' && o.field === 'balance').proposedValue = amount;
        }
        const page = await boot(data, width, theme);
        const strip = page.locator('[data-budget-card-movements]');
        await strip.waitFor();
        const button = strip.getByRole('button', {
          name: `Amazon Reported balance ${expected}${mode === 'unavailable' ? '' : ' as of Aug 8'} Show Amazon Mastercard activity`, exact: true,
        });
        await button.waitFor();
        assert.equal(await button.count(), 1, `${width}px ${theme} ${mode}: computed accessible balance name`);
        assert.equal(await button.getAttribute('data-budget-card-toggle'), 'mbna', 'named button retains canonical identity');
        assert.equal(await button.locator('.card-movement-balance').textContent(), expected + (mode === 'unavailable' ? '' : ' as of Aug 8'), 'visible balance span: amount plus the as-of note when stale');
        assert.equal(await strip.getByRole('button', {
          name: 'Travel Reported balance $927.40 Show Travel activity', exact: true,
        }).count(), 1, 'other numeric card retains its full-label action and balance meaning');
        await capture(strip, `accessible-balance-${mode}-strip-${width}-${theme}.png`,
          { state: 'accessible-balance', mode, width, theme, subject: 'card strip, accessible balance meaning' });
        states.push({ width, theme, state: 'accessible-balance', mode, synthetic: true });
        await page.close(); console.log(`PASS ${width}px ${theme} ${mode}: computed accessible balance name`);
      }
    }
    assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(external, []);
    for (const shot of screenshots) shot.sha256 = sha256File(path.join(out, shot.file));
    fs.writeFileSync(path.join(out, 'proof.json'), JSON.stringify({ synthetic: true,
      generatedBy: 'test/browser-card-period-movements.js', runtime, sourceBlobs,
      basedOn: process.env.ATLAS_PROOF_BASE || null,
      screenshots, states, errors, writes, external }, null, 2) + '\n');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
