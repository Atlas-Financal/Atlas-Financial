'use strict';
// Browser proof for PR #571 (grouped savings member rows): the real App boots
// on an invented ledger whose Forecast publication carries a three-member
// group; the Budget tile, the savings detail sheet and the embedded Savings
// inventory are captured at desktop/390/320 in both themes, and every member
// entry is measured for readability (own box, no horizontal overflow, the
// sheet's member list spanning the goal row's full grid width).
// Run: NODE_PATH=<playwright> CHROME_PATH=<chromium> node test/browser-savings-group-members.js
// ATLAS_MEMBERS_CAPTURE_ONLY=1 records measurements without asserting (used
// for the pre-CSS-repair "before" captures). ATLAS_MEMBERS_PROOF sets the
// output directory. All figures below are the fixture's published values.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto'), cp = require('node:child_process');
const { chromium } = require('playwright');
const consumerData = require('./fixtures/savings-daily-consumer-data');
const root = path.resolve(__dirname, '..'), assets = path.join(root, 'public');
const output = process.env.ATLAS_MEMBERS_PROOF || path.join(require('node:os').tmpdir(), 'atlas-members-proof');
const captureOnly = process.env.ATLAS_MEMBERS_CAPTURE_ONLY === '1';
fs.mkdirSync(output, { recursive: true });

const data = consumerData('ready');
data.plan.commitments.push({ id: 'third', label: 'Invented third club cost', group: 'club', date: '2026-11-04',
  amount: 90, confidence: 'confirmed', adjustable: false, sinkingFund: true });
const MEMBER_KEYS = ['near@2026-10-21', 'far@2026-10-28', 'third@2026-11-04'];
const MEMBER_NEEDS = { 'near@2026-10-21': '60.00', 'far@2026-10-28': '170.00', 'third@2026-11-04': '90.00' };

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const measure = els => els.evaluateAll(nodes => nodes.map(node => {
  const box = node.getBoundingClientRect();
  return { key: node.getAttribute('data-budget-savings-member') || node.getAttribute('data-savings-member'),
    text: node.innerText.replace(/\s+/g, ' ').trim(),
    width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10,
    left: Math.round(box.left * 10) / 10, right: Math.round(box.right * 10) / 10,
    scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
}));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const errors = [], external = [], cases = [];
  try {
    for (const width of [1280, 390, 320]) for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 1100 }, colorScheme: theme, reducedMotion: 'reduce' });
      await page.addInitScript(theme => {
        localStorage.setItem('hfd-plan-knobs-v1', JSON.stringify({ weeklyVariable: 40 }));
        localStorage.setItem('hfd-theme', theme);
      }, theme);
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://members.test') { external.push(url.origin); return route.abort(); }
        if (url.pathname === '/data.json') return route.fulfill({ json: data });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
        const file = path.resolve(assets, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        if (!file.startsWith(assets + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html' });
      });
      await page.goto('http://members.test/');
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);

      // ---- Budget tile ----
      const tile = page.locator('[data-budget-savings-goals]');
      await tile.waitFor({ state: 'visible' });
      const tileMembers = await measure(tile.locator('.budget-goal-member'));
      const tileBox = await tile.evaluate(node => { const b = node.getBoundingClientRect();
        const first = node.querySelector('.budget-goal-member');
        return { width: Math.round(b.width * 10) / 10, height: Math.round(b.height * 10) / 10,
          scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
          firstMemberTopRel: first ? Math.round((first.getBoundingClientRect().top - b.top) * 10) / 10 : null }; });
      await tile.screenshot({ path: path.join(output, `members-tile-${width}-${theme}.png`), animations: 'disabled' });
      cases.push({ surface: 'tile', width, theme, members: tileMembers, container: tileBox });

      // ---- Savings detail sheet ----
      // The blend shell reparents the savings question into the bento grid,
      // so it is located directly, not under the waterfall container.
      const summary = page.locator('[data-operating-question="savings"] > details > summary');
      await summary.waitFor();
      await summary.focus(); await page.keyboard.press('Enter');
      const dialog = page.locator('[data-budget-detail-sheet]'), body = page.locator('[data-budget-detail-body]');
      await dialog.waitFor({ state: 'visible' });
      const sheetMembers = await measure(body.locator('[data-budget-savings-member]'));
      const sheetLayout = await body.evaluate(() => {
        const ul = document.querySelector('[data-budget-detail-body] .budget-savings-members');
        const goal = ul && ul.closest('[data-budget-savings-total-goal]');
        if (!ul || !goal) return null;
        const ub = ul.getBoundingClientRect(), gb = goal.getBoundingClientRect(), cs = getComputedStyle(ul);
        return { ulWidth: Math.round(ub.width * 10) / 10, goalWidth: Math.round(gb.width * 10) / 10,
          ulLeft: Math.round(ub.left * 10) / 10, goalLeft: Math.round(gb.left * 10) / 10,
          gridColumnStart: cs.gridColumnStart, gridColumnEnd: cs.gridColumnEnd };
      });
      await dialog.screenshot({ path: path.join(output, `members-sheet-${width}-${theme}.png`), animations: 'disabled' });
      cases.push({ surface: 'sheet', width, theme, members: sheetMembers, layout: sheetLayout });

      // ---- Embedded Savings inventory (inside the sheet's Info details) ----
      const info = body.locator('[data-budget-savings-info] > summary');
      if (await info.count()) {
        await info.focus(); await page.keyboard.press('Enter');
        const article = body.locator('[data-savings-goal="group:club"]');
        if (await article.count()) {
          const invMembers = await measure(article.locator('[data-savings-member]'));
          await article.screenshot({ path: path.join(output, `members-inventory-${width}-${theme}.png`), animations: 'disabled' });
          cases.push({ surface: 'inventory', width, theme, members: invMembers });
        }
      }
      const docOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      cases.push({ surface: 'document', width, theme, overflowPx: docOverflow });
      await page.close();
    }
  } finally { await browser.close(); }
  assert.deepEqual(external, [], 'no external requests');
  assert.deepEqual(errors, [], 'no page errors');

  const report = { generatedAt: new Date().toISOString(), captureOnly,
    gitHead: cp.execFileSync('git', ['-c', 'safe.directory=' + root.replace(/\\/g, '/'), 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries(['public/plan.js', 'public/savings-inventory.js', 'public/budget-surface.css', 'public/savings-inventory.css']
      .map(file => [file, sha256(path.join(root, file))])),
    cases,
    screenshots: Object.fromEntries(fs.readdirSync(output).filter(f => f.endsWith('.png')).sort()
      .map(f => [f, sha256(path.join(output, f))])) };
  fs.writeFileSync(path.join(output, 'members-report.json'), JSON.stringify(report, null, 1));

  assert.ok(cases.length > 0, 'at least one surface/width/theme case ran');
  if (!captureOnly) {
    for (const entry of cases) {
      if (entry.surface === 'document') { assert.ok(entry.overflowPx <= 0, `document overflow ${entry.overflowPx}px at ${entry.width}/${entry.theme}`); continue; }
      assert.deepEqual(entry.members.map(m => m.key), MEMBER_KEYS, `${entry.surface} ${entry.width}/${entry.theme}: three separate member entries`);
      for (const member of entry.members) {
        assert.ok(member.height > 0 && member.width > 0, `${entry.surface} ${entry.width}/${entry.theme}: ${member.key} has a real box`);
        assert.ok(member.scrollWidth <= member.clientWidth + 1, `${entry.surface} ${entry.width}/${entry.theme}: ${member.key} text overflows its entry (${member.scrollWidth} > ${member.clientWidth})`);
        assert.ok(member.text.includes(MEMBER_NEEDS[member.key]), `${entry.surface} ${entry.width}/${entry.theme}: ${member.key} prints its published needed ${MEMBER_NEEDS[member.key]} — got: ${member.text}`);
      }
      if (entry.surface === 'sheet') {
        assert.ok(entry.layout && entry.layout.ulWidth >= entry.layout.goalWidth - 1,
          `sheet ${entry.width}/${entry.theme}: member list spans the goal row (${entry.layout && entry.layout.ulWidth} vs ${entry.layout && entry.layout.goalWidth})`);
      }
      if (entry.surface === 'tile') {
        assert.ok(entry.container.scrollWidth <= entry.container.clientWidth + 1, `tile ${entry.width}/${entry.theme}: no internal overflow`);
        // The bento face is a fixed-height summary (overflow hidden): the
        // member rows render in the card below the face fold — the same
        // position the goal context line occupies — and are read in the
        // sheet the tile opens, proven on the sheet surface above.
        assert.ok(entry.container.firstMemberTopRel != null, `tile ${entry.width}/${entry.theme}: member rows render inside the tile card`);
      }
    }
  }
  console.log(`MEMBERS PROOF ${captureOnly ? 'CAPTURED (no assertions; not a pass)' : 'PASS'}: ${cases.length} cases, ${Object.keys(report.screenshots).length} screenshots -> ${output}`);
  // Capture-only skips the assertions: it records evidence, it is never a pass.
  if (captureOnly) process.exitCode = 1;
})().catch(error => { console.error(error); process.exit(1); });
