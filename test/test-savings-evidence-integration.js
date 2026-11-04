'use strict';
// The actual authenticated server, observer, reconciliation, applied overlay,
// Forecast and Budget renderer. All transport/evidence is local and synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { state, AS_OF, withoutDiagnostics } = require('./test-savings-evidence');
const F = require('../public/forecast');
const O = require('../scripts/provider-observe');
const ROOT = path.join(__dirname, '..');
const PASS = 'synthetic-savings-password';
const SECRET = 'synthetic-savings-session-secret';
function fixture(sameDate = false) {
  const { data } = state();
  data.debts[0].secured = false;
  data.meta.asOf = data.plan.opening.asOf = sameDate ? AS_OF : '2026-08-13';
  data.plan.startingCash.breakdown.push({ id: 'savings', label: 'Synthetic reserve', value: 5000 });
  const map = { schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'fixture', mappings: [
    ...['chequing-a', 'chequing-b', 'savings'].map((id, i) => ({ providerAccountId: String(1001 + i),
      canonical: { collection: 'cash', id }, atlasRole: 'household-cash' })),
    { providerAccountId: '2001', canonical: { collection: 'debts', id: 'travelvisa' }, atlasRole: 'revolving-credit' },
  ] };
  const payload = { provider: 'lunchmoney', fetchedAt: AS_OF + 'T18:00:00.000Z',
    transactionWindow: { startDate: '2026-08-13', endDate: AS_OF, complete: true, hasMore: false, truncated: false },
    pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false, truncated: false },
    accounts: [{ id: 1001, type: 'cash', balance: 1000 }, { id: 1002, type: 'cash', balance: 0 },
      { id: 1003, type: 'cash', balance: 5000 }, { id: 2001, type: 'credit', balance: 400, credit_limit: 1000 }]
      .map(a => ({ ...a, currency: 'cad', updated_at: AS_OF + 'T17:55:00.000Z', balance_last_update: AS_OF + 'T17:55:00.000Z' })),
    categories: [{ id: 11, name: 'Groceries', is_income: false, exclude_from_totals: false }],
    transactions: [{ id: 91001, account_id: 2001, date: '2026-08-19', amount: 50, currency: 'cad',
      payee: 'Synthetic grocer', category_id: 11, is_pending: true, status: 'unreviewed',
      plaid_metadata: { transaction_id: 'synthetic-pending-identity' } }],
  };
  return { data, map, payload };
}
function addPair(payload, directed = false) {
  payload.transactions.push({ ...payload.transactions[0], id: 91002, is_pending: false, status: 'cleared',
    plaid_metadata: { transaction_id: 'synthetic-posted-identity',
      ...(directed ? { pending_transaction_id: 'synthetic-pending-identity' } : {}) } });
}
function renderer() {
  const context = vm.createContext({ Forecast: F, console, addEventListener() {},
    document: { addEventListener() {}, querySelectorAll() { return []; }, getElementById() { return null; },
      documentElement: { dataset: {}, style: {} } },
    window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/' } });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8'), context);
  vm.runInContext('App.boot = () => {};', context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/plan.js'), 'utf8'), context);
  return served => {
    let advice;
    const stop = new Error('actual Budget recommend complete');
    context.served = served;
    context.Forecast = { ...F, recommend(plan, date, opts) {
      advice = F.recommend(plan, date, opts); throw stop;
    } };
    vm.runInContext('Object.assign(state, served.plan.defaults, { debts: served.debts });', context);
    try { vm.runInContext('renderPlan(served, null, null)', context); }
    catch (e) { if (e !== stop) throw e; }
    finally { context.Forecast = F; }
    assert.ok(advice);
    const row = advice.payPeriodViews.find(p => p.fromTodayFunding);
    context.row = row; context.alloc = advice.paydayAllocation;
    const html = row ? vm.runInContext('calendarWaterfallHtml(row, served.liveOverlay, alloc, served.plan)', context) : '';
    return { advice, row, proposal: row?.fromTodayFunding, html,
      todayHtml: html.split('<section class="calendar-waterfall"')[0] };
  };
}
async function withServer(input, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-savings-server-'));
  let child;
  const diskBefore = fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8');
  try {
    for (const name of ['scripts', 'public', 'docs']) fs.cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(dir, 'server.js'));
    fs.mkdirSync(path.join(dir, 'snapshots'));
    const write = next => {
      fs.writeFileSync(path.join(dir, 'public/periods.json'), JSON.stringify(next.periods || null));
      fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(next.data));
      fs.writeFileSync(path.join(dir, 'observation.json'), JSON.stringify(next.payload));
      fs.writeFileSync(path.join(dir, 'map.json'), JSON.stringify(next.map));
    };
    write(input);
    const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(ATLAS_|LUNCHMONEY_|SITE_PASSWORD|SESSION_SECRET)/.test(key)) delete env[key];
    Object.assign(env, { SITE_PASSWORD: PASS, SESSION_SECRET: SECRET, PORT: String(port),
      NODE_PATH: path.join(ROOT, 'node_modules'), ATLAS_LIVE_OVERLAY: 'fixture',
      ATLAS_LIVE_OVERLAY_FIXTURE: path.join(dir, 'observation.json'), ATLAS_LIVE_OVERLAY_MAP: path.join(dir, 'map.json') });
    child = spawn(process.execPath, [path.join(dir, 'server.js')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic Atlas startup timed out')), 10000);
      child.stdout.on('data', chunk => { if (/listening/.test(String(chunk))) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Synthetic Atlas exited ' + code)); });
      child.stderr.on('data', () => {});
    });
    const base = 'http://127.0.0.1:' + port;
    const locked = await fetch(base + '/data.json', { redirect: 'manual' });
    assert.equal(locked.status, 401, 'production authentication gate is present');
    const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + PASS });
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    await fn({ base, cookie, write, get: async () => {
      const res = await fetch(base + '/data.json', { headers: { cookie } });
      assert.equal(res.status, 200); return res.json();
    } });
  } finally {
    if (child && child.exitCode == null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'), diskBefore, 'canonical input unchanged');
  }
}
async function main() {
  const render = renderer();
  await withServer(fixture(), async server => {
    for (const sameDate of [false, true]) {
      const input = fixture(sameDate); server.write(input);
      const complete = await server.get();
      assert.equal(complete.liveOverlay.applied, true);
      assert.ok(O.currentPeriodActualsLooksSanitized(complete.liveOverlay.currentPeriodActuals));
      const control = render(complete);
      assert.equal(control.proposal.status, 'ready');
      assert.equal(control.proposal.availableNow, 1000 - 200 - 150 - 25 - (300 - 50) - 50 - 50);
      assert.equal(control.proposal.contribution, 250);
      assert.match(control.todayHtml, /Proposed to set aside now<\/span><span>\$250\.00/);
      addPair(input.payload); server.write(input);
      const held = await server.get(), shown = render(held);
      assert.equal(held.liveOverlay.applied, true);
      assert.equal(held.liveOverlay.currentPeriodActuals.pendingCoverage, 'complete');
      assert.ok(held.liveOverlay.currentPeriodActuals.transactions.some(t => t.pendingPostedDuplicate));
      assert.equal(shown.proposal.status, 'unavailable');
      assert.equal(shown.proposal.contribution, null);
      assert.deepEqual(shown.proposal.evidenceFailures.map(r => r.code), ['card-purchase-coverage-unconfirmed', 'pending-possible-replacement']);
      assert.match(shown.todayHtml, /Synthetic card.*Groceries.*2026-08-19/);
      assert.match(shown.todayHtml, /one purchase or two/);
      assert.doesNotMatch(shown.todayHtml, /\$|synthetic-pending-identity|synthetic-posted-identity|Synthetic grocer|data-from-today-cost/);
      assert.deepEqual(render(await server.get()).proposal, shown.proposal, 'same-date observation is idempotent');
      // Advance all evidence together: the unresolved pair remains a hold.
      input.payload.fetchedAt = '2026-08-21T18:00:00.000Z';
      input.payload.transactionWindow.endDate = '2026-08-21';
      input.payload.accounts.forEach(a => { a.updated_at = '2026-08-21T17:55:00.000Z'; a.balance_last_update = '2026-08-21T17:55:00.000Z'; });
      server.write(input);
      const advanced = render(await server.get());
      assert.equal(advanced.proposal.asOf, '2026-08-21');
      assert.deepEqual(advanced.proposal.evidenceFailures, shown.proposal.evidenceFailures);
      // Real directed provider identity collapses the pair. No matcher is
      // added for diagnostics, and a changed posted amount still wins once.
      input.payload.transactions[1].plaid_metadata.pending_transaction_id = 'synthetic-pending-identity';
      input.payload.transactions[1].amount = 45;
      input.payload.accounts[3].balance = 445;
      server.write(input);
      const settledData = await server.get(), settled = render(settledData);
      assert.equal(settledData.liveOverlay.applied, true, JSON.stringify(settledData.liveOverlay));
      assert.equal(settledData.liveOverlay.currentPeriodActuals.transactions.length, 1);
      assert.equal(settledData.debts[0].pending, 0);
      assert.equal(settled.proposal.status, 'ready');
      assert.equal(settled.proposal.remainingHousehold, 300 - 45);
      assert.equal(settled.proposal.evidenceFailures, undefined);
      input.payload.transactions.shift(); server.write(input);
      assert.deepEqual(withoutDiagnostics(render(await server.get()).proposal), withoutDiagnostics(settled.proposal),
        'posted-only refresh equals directed pending-to-posted survivor');
      // Missing same-date stock cannot inherit a canonical account balance.
      const missing = fixture(sameDate); missing.payload.accounts.splice(1, 1); server.write(missing);
      const absent = render(await server.get());
      if (sameDate) {
        assert.equal(absent.proposal.status, 'unavailable');
        assert.ok(absent.proposal.evidenceFailures.some(r => r.code === 'cash-observation-account'));
      } else assert.equal(absent.advice.operatingPlanUnavailable, true);
    }
    const hostile = fixture(); addPair(hostile.payload);
    hostile.data.debts[0].label = '<img src=x onerror=alert(1)>';
    hostile.data.plan.budget.categories[0].label = '<script>throw 1</script>';
    server.write(hostile);
    const escaped = render(await server.get()).todayHtml;
    assert.match(escaped, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(escaped, /Groceries/, 'Forecast keeps its incumbent category label');
    assert.doesNotMatch(escaped, /<img|<script|\$/);
  });
  console.log('PASS savings evidence integration: authenticated server -> observer -> reconciliation -> overlay -> actual Forecast/Budget; same/advancing dates, pending/posted changes, missing accounts, escaping, amount-free holds');
}
module.exports = { fixture, addPair, renderer, withServer };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
