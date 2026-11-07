'use strict';
// Real selector and renderer proof. Only invented inputs, intercepted GETs.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), cp = require('node:child_process');
const { chromium } = require('playwright');
const fixture = require('./fixtures/savings-future-closing-data');
const ownerModel = require('./fixtures/savings-owner-closing-data');
const deficitModel = require('./fixtures/savings-deficit-coverage-data');
const shell = require('./fixtures/savings-daily-consumer-data');
const root = path.resolve(__dirname, '..'), assets = path.join(root, 'public');
const out = process.env.ATLAS_FUTURE_SAVINGS_PROOF || path.join(require('node:os').tmpdir(), 'atlas-future-savings-proof');
fs.mkdirSync(out, { recursive: true });
const cases = [], errors = [], external = [], writes = [], served = new Map();
const hash = body => crypto.createHash('sha256').update(body).digest('hex');
// #808 deliberately marks each row-owned Still to fund as an estimate.
// Check that exact qualification before allowing only its "estimated" word
// through the older close-copy guard. All other fields keep that guard.
async function closeCopyWithoutGapMarks(tile, text) {
  let copy = text.replace(/\s+/g, ' ');
  for (const cell of await tile.locator('[data-budget-goal-still-to-fund]').all()) {
    const printed = (await cell.innerText()).replace(/\s+/g, ' ');
    if (printed.startsWith('Unknown')) continue;
    assert.match(printed, /^≈ estimated \$[\d,]+\.\d{2} Estimate: Needed minus Saved\. It is a planning gap, not an unpaid balance\.$/,
      'Still to fund carries its estimate mark and planning-gap reason');
    assert.ok(copy.includes(printed), 'qualified Still to fund appears in the checked tile text');
    copy = copy.replace(printed, printed.replace('estimated ', ''));
  }
  return copy;
}
async function step(page, direction) {
  const before = await page.locator('[data-budget-window-progress]').getAttribute('data-start');
  await page.locator('.river').focus();
  await page.keyboard.press(direction > 0 ? 'ArrowRight' : 'ArrowLeft');
  await page.waitForFunction(start => document.querySelector('[data-budget-window-progress]')?.dataset.start !== start, before);
}
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try { for (const width of [1440, 390, 320]) for (const mode of ['ready', 'group', 'installments', 'gap', 'zero', 'expense', 'unknown', 'owner80', 'owner1000', 'owner-deficit', 'timing', 'carry', 'fallback', 'fallback-short']) {
    const owner = mode.startsWith('owner') || mode === 'timing';
    const deficit = ['carry', 'fallback', 'fallback-short'].includes(mode);
    const x = deficit ? deficitModel(mode === 'carry' ? 400 : 100, 200, mode === 'fallback-short' ? 50 : 500)
      : owner ? ownerModel(mode === 'owner80' || mode === 'timing' ? 80 : 1000, mode === 'owner-deficit' ? 100 : 400) : fixture();
    if (mode === 'timing') { x.plan.income[1].date = '2026-10-24'; x.plan.commitments[0].date = '2026-10-16'; }
    const data = shell('ready'); data.meta.asOf = x.asOf; data.plan = x.plan;
    data.plan.groups = [];
    if (mode === 'group') { data.plan.groups = [{ id: 'shared', label: 'Invented shared group', planSpendSummary: true }];
      data.plan.commitments.forEach(c => { c.group = 'shared'; }); }
    if (mode === 'installments') {
      data.plan.groups = [{ id: 'installments', label: 'Invented installment group', planSpendSummary: true }];
      data.plan.commitments = [
        { id: 'one', label: 'Invented installment one', group: 'installments', date: '2026-10-29', amount: 80, confidence: 'confirmed', sinkingFund: true },
        { id: 'two', label: 'Invented installment two', group: 'installments', date: '2026-11-12', amount: 60, confidence: 'confirmed', sinkingFund: true },
        { id: 'later', label: 'Invented later requirement', date: '2027-01-04', amount: 3000, confidence: 'confirmed', sinkingFund: true }];
    }
    if (mode === 'gap' || mode === 'zero') {
      data.plan.defaults.targetBuffer = 0;
      data.plan.startingCash.breakdown[0].value = data.plan.opening.paydaySnapshot.opening = mode === 'zero' ? 100 : 0;
      data.plan.savingsPoolObservation.accounts[0].value = data.plan.startingCash.breakdown[2].value = mode === 'zero' ? 1100 : 800;
      data.plan.savingsPoolObservation.accounts[1].value = data.plan.startingCash.heldElsewhere[0].value = 0;
      data.plan.income[1].amount = data.plan.income[2].amount = 200;
      data.plan.income.push({ id: 'p3', label: 'Invented third receipt', frequency: 'once', date: '2026-11-13', amount: 200, confidence: 'confirmed' });
      data.plan.commitments = [
        { id: 'a', label: 'Invented first cost', date: '2026-10-29', amount: 500, confidence: 'confirmed', sinkingFund: true },
        { id: 'b', label: 'Invented second cost', date: '2026-11-12', amount: 600, confidence: 'confirmed', sinkingFund: true },
        { id: 'c', label: 'Invented third cost', date: '2026-11-26', amount: 400, confidence: 'confirmed', sinkingFund: true }];
    }
    if (mode === 'expense') { data.plan.commitments[0].date = '2026-11-03'; data.plan.commitments[0].amount = 80; }
    if (mode === 'unknown') delete x.opts.currentPeriodActuals;
    data.liveOverlay = { applied: true, operatingPlan: 'live', ...x.opts,
      observedCash: { asOf: x.asOf, complete: true, accounts: data.plan.startingCash.breakdown
        .filter(r => r.id.startsWith('chequing')).map(r => ({ ...r, evidenceDate: x.asOf })) } };
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    await page.addInitScript(() => localStorage.setItem('hfd-plan-knobs-v1', JSON.stringify({ weeklyVariable: 0 })));
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://future-savings.test') { external.push(url.origin); return route.abort(); }
      if (route.request().method() !== 'GET') { writes.push(route.request().method()); return route.abort(); }
      if (url.pathname === '/data.json') return route.fulfill({ json: data });
      if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
      const file = path.resolve(assets, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(assets + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const body = fs.readFileSync(file); served.set(path.relative(root, file).replaceAll('\\', '/'), hash(body));
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://future-savings.test/');
    const tile = page.locator('[data-budget-savings-goals]'); await tile.waitFor();
    const current = await tile.innerText(), before = await page.evaluate(() => JSON.stringify(App.data));
    assert.doesNotMatch(current, /Savings at period close/);
    await step(page, 1);
    const first = await tile.innerText(); assert.match(first, /Savings at period close/);
    assert.doesNotMatch(await closeCopyWithoutGapMarks(tile, first), /\bForecast\b|\bActual\b|estimated|assumptions|If eligible surplus/i);
    if (mode === 'unknown') assert.match(first, /Unavailable/);
    else if (mode === 'owner-deficit' || mode === 'timing') { assert.match(first, /Unavailable/);
      assert.match(first, mode === 'timing' ? /Funding gap on 2026-10-29: \$200\.00/ : /Funding gap on 2026-10-29: \$200\.00/); }
    else if (owner) assert.match(first, /200\.00/);
    else if (deficit) assert.match(first, mode === 'carry' ? /500\.00/ : mode === 'fallback-short' ? /50\.00/ : /500\.00/);
    else if (mode === 'installments') {
      assert.match(first, /39\.00/); assert.match(first, /Invented installment two/i);
      assert.doesNotMatch(first, /Invented installment one/i);
    } else if (mode === 'gap' || mode === 'zero') assert.match(first, mode === 'zero' ? /600\.00/ : /300\.00/);
    else assert.match(first, /119\.00/);
    await step(page, 1);
    const second = await tile.innerText();
    if (mode === 'ready' || mode === 'group') { assert.match(second, /1,119\.00/); assert.match(second, /1,500\.00/); }
    if (mode === 'expense') { assert.match(second, /1,039\.00/); assert.doesNotMatch(second, /Invented first goal/i); }
    if (mode === 'installments') { assert.match(second, /979\.00/); assert.doesNotMatch(second, /Invented installment/i); }
    if (mode === 'gap') assert.match(second, /100\.00/);
    if (mode === 'zero') assert.match(second, /200\.00/);
    if (mode === 'unknown') assert.match(second, /Unavailable/);
    if (mode === 'owner80' || mode === 'owner1000') { assert.match(second, /200\.00/); }
    if (mode === 'owner-deficit') { assert.match(second, /Unavailable/); assert.match(second, /Funding gap on 2026-11-12: \$500\.00/); }
    if (mode === 'timing') { assert.match(second, /Unavailable/); assert.match(second, /Funding gap on 2026-11-12: \$200\.00/); }
    if (mode === 'carry') assert.match(second, /900\.00/);
    if (mode === 'fallback') assert.match(second, /600\.00/);
    if (mode === 'fallback-short') { assert.match(second, /150\.00/); assert.doesNotMatch(second, /Unavailable/); }
    // Payday sweep (owner direction 2026-10-14): each period's surplus lands
    // on the FOLLOWING payday, so the closes that used to complete at the
    // second view now complete one payday later. Anchor the dialog/trust
    // proof on that third close for these modes.
    let anchor = second, depth = 2;
    if (mode === 'ready' || mode === 'group' || mode === 'owner80' || mode === 'owner1000') {
      await step(page, 1); anchor = await tile.innerText(); depth = 3;
      if (mode === 'ready' || mode === 'group') { assert.match(anchor, /2,119\.00/); assert.match(anchor, /1,500\.00/); assert.match(anchor, /619\.00/); }
      else { assert.match(anchor, /200\.00/); assert.match(anchor, /No remaining Savings requirements/); }
    }
    await tile.locator('[data-budget-funding-inventory]').focus(); await page.keyboard.press('Enter');
    const dialog = page.locator('[data-budget-detail-sheet]'); await dialog.waitFor({ state: 'visible' });
    const info = dialog.locator('[data-budget-savings-info] > summary');
    if (!await info.evaluate(node => node.parentElement.open)) await info.click();
    await dialog.locator('[data-savings-inventory]').waitFor({ state: 'visible' });
    await dialog.locator('[data-savings-inventory] > details > summary').click();
    const inventory = await dialog.locator('[data-savings-inventory]').innerText();
    assert.match(inventory, /Savings at period close/);
    if (mode !== 'unknown') assert.doesNotMatch(inventory, /\bForecast\b|\bActual\b|estimated|assumptions|If eligible surplus|this scenario/i);
    if (mode === 'ready' || mode === 'group') assert.match(inventory, /2,119\.00/);
    if (mode === 'group') { assert.match(inventory, /1,500\.00/); assert.match(inventory, /619\.00/); }
    if (mode === 'expense') assert.match(inventory, /1,039\.00/);
    if (mode === 'installments') { assert.match(inventory, /979\.00/); assert.doesNotMatch(inventory, /Invented installment/i); }
    if (mode === 'gap') assert.match(inventory, /100\.00/);
    if (mode === 'zero') assert.match(inventory, /200\.00/);
    if (mode === 'unknown') assert.match(inventory, /Unknown/);
    if (mode === 'owner80' || mode === 'owner1000') assert.match(inventory, /200\.00/);
    if (mode === 'owner-deficit' || mode === 'timing') { assert.match(inventory, /Unknown|Unavailable/); assert.match(inventory, /Funding gap/); }
    if (mode === 'carry') assert.match(inventory, /900\.00/);
    if (mode === 'fallback') { assert.match(inventory, /600\.00/); assert.doesNotMatch(await dialog.innerText(), /Deficit coverage/,
      'no Deficit coverage line exists anymore: Savings never covers a routine Bills deficit'); }
    if (mode === 'fallback-short') { assert.match(inventory, /150\.00/); assert.doesNotMatch(inventory, /Funding gap/); }
    // Systems Review 2026-10-14 (PR #616 finding 3): the ready Savings
    // surfaces must print the Forecast-owned signed Bills position and, when
    // one exists, the dated uncovered gap — a generic statement that
    // deficits are shown is not sufficient. The deficit modes' anchor close
    // is ready with Bills at -180 and a 200 gap dated 2026-11-03 (pinned at
    // the packet level in test-savings-sweep-review-regressions.js).
    const infoText = await dialog.locator('[data-budget-savings-info]').innerText();
    if (mode === 'carry' || mode === 'fallback' || mode === 'fallback-short') {
      assert.match(second, /Bills at period close/); assert.match(second, /180\.00/);
      assert.match(second, /Bills shortfall of/); assert.match(second, /200\.00/);
      assert.match(infoText, /Bills at period close/); assert.match(infoText, /180\.00/);
      assert.match(infoText, /Uncovered Bills gap/); assert.match(infoText, /200\.00/);
    }
    if (mode === 'ready') {
      assert.match(anchor, /Bills at period close/);
      assert.match(infoText, /Bills at period close/); assert.match(infoText, /80\.00/);
      assert.doesNotMatch(infoText, /Uncovered Bills gap/);
    }
    const trust = await page.evaluate(() => {
      const d = App.data, advice = Forecast.recommend(d.plan, d.meta.asOf,
        { ...d.plan.defaults, ...d.liveOverlay, weeklyVariable: 0, debts: d.debts || [] });
      const start = document.querySelector('[data-budget-window-progress]').dataset.start;
      const selected = advice.payPeriodViews.find(p => p.start === start);
      const packet = Forecast.savingsFundingPublication(advice.savingsFunding,
        { asOf: d.meta.asOf, advice, periodId: selected.id });
      return { trust: packet.forecastClosing?.trust, actualSaved: packet.forecastClosing?.actualSaved,
        nature: packet.forecastClosing?.nature, basis: packet.forecastClosing?.cashBasis,
        action: packet.forecastClosing?.actionPermission, status: packet.forecastClosing?.status,
        stock: packet.forecastClosing?.stock, diagnostics: packet.forecastClosing?.diagnostics,
        operating: packet.forecastClosing?.operatingCash, coverage: packet.forecastClosing?.projectedDeficitCoverage };
    });
    assert.equal(trust.actualSaved, null); assert.equal(trust.action, 'not-granted');
    // Trust follows the close's own status: a ready close publishes
    // estimated provenance; an unavailable close withholds it as unknown.
    // (Under the payday sweep, gap's anchor close is itself unavailable,
    // where carry-first published it ready — the contract is per-state.)
    if (mode !== 'unknown') { if (trust.status === 'unavailable') assert.equal(trust.trust, 'unknown');
      else { assert.equal(trust.trust, 'estimated'); assert.equal(trust.nature, 'if-eligible-surplus-saved');
        assert.equal(trust.basis, 'opening-savings-plus-eligible-surplus-minus-goal-costs'); } }
    if (mode === 'owner80' || mode === 'owner1000') { assert.equal(trust.stock, 200); assert.equal(trust.operating, mode === 'owner80' ? 80 : 1000); }
    if (mode === 'owner-deficit') { assert.equal(trust.stock, null); assert.equal(trust.diagnostics.signedSavings, -500); }
    if (mode === 'timing') { assert.equal(trust.stock, null); assert.equal(trust.diagnostics.signedSavings, -200); }
    if (mode === 'carry' || mode === 'fallback') { assert.equal(trust.stock, mode === 'carry' ? 900 : 600);
      assert.equal(trust.operating, -180); assert.equal(trust.coverage, 0); }
    if (mode === 'fallback-short') { assert.equal(trust.stock, 150); assert.equal(trust.operating, -180); assert.equal(trust.coverage, 0); }
    await dialog.screenshot({ path: path.join(out, `${mode}-${width}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
    if (mode === 'gap') {
      await step(page, 1); const failure = await tile.innerText();
      assert.match(failure, /Funding gap on 2026-11-26: \$300\.00/);
      assert.match(failure, /Unavailable/); assert.doesNotMatch(failure, /Invented first cost|Invented second cost/i);
      await step(page, -1); assert.equal(await tile.innerText(), second);
    }
    if (mode === 'zero') {
      await step(page, 1); const empty = await tile.innerText();
      assert.match(empty, /\$0\.00/); assert.match(empty, /No remaining Savings requirements/i);
      assert.doesNotMatch(empty, /Unavailable|Funding gap/);
      await tile.screenshot({ path: path.join(out, `zero-closing-${width}.png`), animations: 'disabled' });
      await step(page, -1); assert.equal(await tile.innerText(), second);
    }
    for (let n = 0; n < depth; n++) await step(page, -1);
    assert.equal(await tile.innerText(), current);
    for (let n = 0; n < depth; n++) await step(page, 1);
    assert.equal(await tile.innerText(), anchor);
    await page.evaluate(() => App.rerender()); assert.equal(await tile.innerText(), anchor);
    assert.equal(await page.evaluate(() => JSON.stringify(App.data)), before);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    cases.push({ width, mode, first, second, inventory, internalPublication: trust, replay: true, currentRestored: true, immutable: true });
    console.log('PASS ' + mode + ' ' + width); await page.close();
  } } finally { await browser.close(); }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []);
  const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(out, 'proof.json'), JSON.stringify({ head, synthetic: true, cases,
    served: Object.fromEntries(served), errors, external, writes }, null, 2) + '\n');
})().catch(e => { console.error(e); process.exitCode = 1; });
