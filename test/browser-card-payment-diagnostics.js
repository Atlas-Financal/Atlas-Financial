'use strict';
// Real App.boot + native card sheet, invented served evidence, intercepted GETs.
// The companion unit suite proves the same allocation through provider-observe.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { chromium } = require('playwright');
const fx = require('./fixtures/card-period-movements-data');
const root = path.resolve(__dirname, '..');
const out = process.env.ATLAS_CARD_DIAGNOSTICS_PROOF_DIR || path.join(require('node:os').tmpdir(), 'atlas-card-payment-diagnostics-proof');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sources = {}, states = [], errors = [], requests = [];
const bind = file => {
  const bytes = fs.readFileSync(file);
  // Git normalizes these text sources to LF; Windows checks them out as CRLF.
  // Bind the executed source text to canonical repository bytes on either host.
  const canonical = /\.(js|css|html|json|svg)$/.test(file) ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n')) : bytes;
  sources[path.relative(root, file).split(path.sep).join('/')] = sha(canonical);
};
bind(__filename);
for (const file of Object.keys(require.cache).filter(file => file.startsWith(path.join(__dirname, 'fixtures') + path.sep))) bind(file);
function dataFor(state) {
  const data = fx.served();
  data.plan.cardPurchaseCoverage = { opening: { asOf: fx.START, confirmed: true, currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] },
    payments: [{ id: 'invented-browser-allocation', confirmed: true, debitRef: 'invented-cash-leg-a', creditRef: 'invented-payment-a',
      allocations: [{ purchaseRef: 'invented-charge-a', amount: 100 }], otherAmount: 0, otherPurpose: null }],
    refunds: [{ confirmed: true, refundRef: 'invented-refund-a', purchaseRef: 'invented-charge-a' }], reversals: [] };
  if (state === 'unknown-opening') data.plan.cardPurchaseCoverage.opening.confirmed = false;
  if (state === 'no-intent') data.plan.cardPurchaseCoverage.payments = [];
  if (state === 'pending') data.liveOverlay.currentPeriodActuals.transactions.find(tx => tx.id === 'payment-a').pending = true;
  if (state === 'shared-debit' || state === 'purchase-over-allocation') {
    data.liveOverlay.currentPeriodActuals.transactions.push(
      { id: 'browser-second-purchase', coverageRef: 'invented-browser-second-purchase', atlasAccountId: 'travelvisa', account: 'travelvisa', accountRole: 'revolving-credit',
        date: fx.AS_OF, amount: 100, currency: 'cad', displayedPayee: 'Invented second purchase', categoryLabel: 'Groceries', pending: false },
      { id: 'browser-second-credit', coverageRef: 'invented-browser-second-credit', atlasAccountId: 'travelvisa', account: 'travelvisa', accountRole: 'revolving-credit',
        date: fx.AS_OF, amount: -100, currency: 'cad', displayedPayee: 'Invented second payment', categoryLabel: 'Credit Card Payment', kindHint: 'payment', pending: false });
    data.plan.cardPurchaseCoverage.payments.push({ id: 'invented-browser-second-allocation', confirmed: true,
      debitRef: 'invented-cash-leg-a', creditRef: 'invented-browser-second-credit',
      allocations: [{ purchaseRef: 'invented-browser-second-purchase', amount: 100 }], otherAmount: 0, otherPurpose: null });
    if (state === 'purchase-over-allocation') {
      const packet = data.liveOverlay.currentPeriodActuals;
      packet.transactions = packet.transactions.filter(tx => tx.id !== 'browser-second-purchase');
      packet.transactions.push({ id: 'browser-second-cash', coverageRef: 'invented-browser-second-cash', atlasAccountId: 'chequing-a', account: 'chequing-a', accountRole: 'household-cash',
        date: fx.AS_OF, amount: 100, currency: 'cad', categoryLabel: 'Credit Card Payment', kindHint: 'payment', pending: false });
      Object.assign(data.plan.cardPurchaseCoverage.payments[1], { debitRef: 'invented-browser-second-cash', allocations: [{ purchaseRef: 'invented-charge-a', amount: 100 }] });
      data.debts.find(row => row.id === 'travelvisa').balance = 827.40;
      data.liveOverlay.cardPeriodBalanceEvidence.cards.find(row => row.id === 'travelvisa').closing.amount = 827.40;
      data.liveOverlay.overlays.find(row => row.locator === 'debts:travelvisa').proposedValue = 827.40;
      data.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value = 765;
      const cash = data.liveOverlay.observedCash?.accounts?.find(row => row.id === 'chequing-a'); if (cash) cash.value = 765;
    }
  }
  if (['reversal', 'ambiguous-parent', 'shared-reversal-cash', 'shared-reversal-card', 'parent-over-reversal'].includes(state)) {
    const packet = data.liveOverlay.currentPeriodActuals;
    packet.transactions.push({ id: 'browser-card-reversal', coverageRef: 'invented-browser-card-reversal',
      atlasAccountId: 'travelvisa', account: 'travelvisa', accountRole: 'revolving-credit',
      date: fx.AS_OF, amount: 20, currency: 'cad', displayedPayee: 'Invented reversal', categoryLabel: 'Credit Card Payment', kindHint: 'payment', pending: false },
    { id: 'browser-cash-reversal', coverageRef: 'invented-browser-cash-reversal', atlasAccountId: 'chequing-a', account: 'chequing-a',
      accountRole: 'household-cash', date: fx.AS_OF, amount: -20, currency: 'cad', categoryLabel: 'Credit Card Payment', kindHint: 'payment', pending: false });
    data.plan.cardPurchaseCoverage.reversals.push({ confirmed: true, paymentId: 'invented-browser-allocation',
      cardDebitRef: 'invented-browser-card-reversal', cashCreditRef: 'invented-browser-cash-reversal',
      allocations: [{ purchaseRef: 'invented-charge-a', amount: 20 }], otherAmount: 0 });
    // Independent 2000-cent reversal: liability and Bills stock each rise by
    // 20. It is not another purchase and does not manufacture a discrepancy.
    data.debts.find(row => row.id === 'travelvisa').balance = 947.40;
    data.liveOverlay.cardPeriodBalanceEvidence.cards.find(row => row.id === 'travelvisa').closing.amount = 947.40;
    data.liveOverlay.overlays.find(row => row.locator === 'debts:travelvisa').proposedValue = 947.40;
    data.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value = 885;
    const cash = data.liveOverlay.observedCash?.accounts?.find(row => row.id === 'chequing-a');
    if (cash) cash.value = 885;
    if (state === 'ambiguous-parent') data.plan.cardPurchaseCoverage.payments.push(structuredClone(data.plan.cardPurchaseCoverage.payments[0]));
    if (['shared-reversal-cash', 'shared-reversal-card', 'parent-over-reversal'].includes(state)) {
      const second = structuredClone(data.plan.cardPurchaseCoverage.reversals[0]);
      if (state !== 'shared-reversal-card') {
        packet.transactions.push({ ...packet.transactions.find(tx => tx.id === 'browser-card-reversal'), id: 'browser-second-reversal-card', coverageRef: 'invented-browser-second-reversal-card' });
        second.cardDebitRef = 'invented-browser-second-reversal-card';
      }
      if (state !== 'shared-reversal-cash') {
        packet.transactions.push({ ...packet.transactions.find(tx => tx.id === 'browser-cash-reversal'), id: 'browser-second-reversal-cash', coverageRef: 'invented-browser-second-reversal-cash' });
        second.cashCreditRef = 'invented-browser-second-reversal-cash';
      }
      data.plan.cardPurchaseCoverage.reversals.push(second);
      if (state === 'parent-over-reversal') {
        for (const tx of packet.transactions) if (tx.id.includes('reversal')) tx.amount = tx.amount > 0 ? 60 : -60;
        data.plan.cardPurchaseCoverage.reversals.forEach(row => { row.allocations[0].amount = 60; });
      }
      const debt = state === 'shared-reversal-cash' ? 967.40 : state === 'shared-reversal-card' ? 947.40 : 1047.40;
      const bills = state === 'shared-reversal-cash' ? 885 : state === 'shared-reversal-card' ? 905 : 985;
      data.debts.find(row => row.id === 'travelvisa').balance = debt;
      data.liveOverlay.cardPeriodBalanceEvidence.cards.find(row => row.id === 'travelvisa').closing.amount = debt;
      data.liveOverlay.overlays.find(row => row.locator === 'debts:travelvisa').proposedValue = debt;
      data.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value = bills;
      if (cash) cash.value = bills;
    }
  }
  if (state === 'plan-unavailable') data.liveOverlay.operatingPlan = 'unavailable';
  return data;
}
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  const runtime = { node: process.version, chromium: await browser.version(), platform: process.platform };
  try {
    for (const width of [1440, 320]) for (const state of ['confirmed', 'unknown-opening', 'no-intent', 'pending', 'reversal', 'plan-unavailable', 'shared-debit', 'ambiguous-parent',
      'shared-reversal-cash', 'shared-reversal-card', 'purchase-over-allocation', 'parent-over-reversal']) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        requests.push({ origin: url.origin, method: request.method() });
        if (url.origin !== 'http://card-diagnostics.test' || request.method() !== 'GET') return route.abort();
        if (url.pathname === '/data.json') return route.fulfill({ json: dataFor(state) });
        if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(url.pathname)) return route.fulfill({ json: null });
        const file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        bind(file);
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      });
      await page.goto('http://card-diagnostics.test/?view=classic');
      const travel = page.locator('[data-budget-card-toggle="travelvisa"]');
      await travel.waitFor();
      await travel.click();
      const panel = page.locator('[data-budget-card-panel="travelvisa"]');
      await panel.waitFor({ state: 'visible' });
      const text = await panel.innerText();
      assert.doesNotMatch(text, /at posting/i);
      if (['confirmed', 'unknown-opening', 'plan-unavailable', 'reversal', 'shared-reversal-cash', 'shared-reversal-card', 'parent-over-reversal'].includes(state)) {
        assert.match(text, /Confirmed payment allocation: purchase coverage \$100\.00/);
        assert.match(text, /Example grocer|Groceries/);
      } else assert.doesNotMatch(text, /Confirmed payment allocation:/);
      if (['ambiguous-parent', 'shared-reversal-cash', 'shared-reversal-card', 'parent-over-reversal'].includes(state)) {
        assert.doesNotMatch(text, /Confirmed allocation reversal:/);
        assert.match(text, /Posted movement · reversal allocation unconfirmed/);
      }
      if (state === 'reversal') {
        assert.match(text, /Confirmed allocation reversal: purchase coverage removed \$20\.00 \/ other allocation reversed \$0\.00/);
        assert.match(text, /\$947\.40/);
        assert.doesNotMatch(text, /Balances and posted activity do not reconcile/);
      }
      assert.match(text, /historical coverage|available cash/);
      assert.doesNotMatch(text, /invented-(?:cash-leg|payment|charge|browser-allocation)|coverageRef|purchaseRef|pc-/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no viewport overflow');
      const allocation = panel.locator('[data-card-payment-allocation="reconciled"]');
      if (['no-intent', 'pending', 'shared-debit', 'ambiguous-parent', 'purchase-over-allocation'].includes(state)) assert.equal(await allocation.count(), 0);
      if (width === 320 && state === 'unknown-opening') await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      const file = state + '-' + width + '.png';
      await page.locator('[data-budget-detail-sheet]').screenshot({ path: path.join(out, file), animations: 'disabled' });
      await page.keyboard.press('Escape');
      assert.equal(await travel.evaluate(node => node === document.activeElement), true, 'native sheet restores trigger focus');
      const cashback = page.locator('[data-budget-card-toggle="cashback"]');
      await cashback.click();
      const otherPanel = page.locator('[data-budget-card-panel="cashback"]');
      assert.doesNotMatch(await otherPanel.innerText(), /Confirmed payment allocation:/, 'another card never inherits the confirmed allocation');
      states.push({ state, width, screenshot: file, sha256: sha(fs.readFileSync(path.join(out, file))) });
      await page.close();
      console.log('PASS card diagnostics ' + state + ' ' + width + 'px');
    }
    assert.deepEqual(errors, []);
    assert.equal(requests.every(row => row.origin === 'http://card-diagnostics.test' && row.method === 'GET'), true);
    fs.writeFileSync(path.join(out, 'proof.json'), JSON.stringify({ synthetic: true, runtime, sourceNormalization: 'utf8-text-lf', sourceSha256: sources,
      states, errors, externalRequests: 0, writeRequests: 0 }, null, 2) + '\n');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
