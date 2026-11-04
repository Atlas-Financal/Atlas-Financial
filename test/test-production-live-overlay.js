'use strict';
/* Production-boundary proofs for on-demand read-only Lunch Money overlay.
 *
 * Starts server.js with synthetic SITE_PASSWORD / SESSION_SECRET and a
 * loopback Lunch Money mock. Independent remaining arithmetic uses fixture
 * dollars and declared plannedPayday / monthly targets, not the server.
 * Never writes canonical files. Never commits a real token or live
 * provider account id.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const O = require('../scripts/provider-observe.js');
const RT = require('../scripts/refresh-trust.js');
const Forecast = require('../public/forecast.js');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');
const POSITIONS = path.join(ROOT, 'docs', 'positions.csv');
const SNAPSHOT_DIR = path.join(ROOT, 'snapshots');
const PASS = 'synthetic-site-password';
const SECRET = 'synthetic-session-secret';
const SYNTHETIC_TOKEN = 'synthetic-readonly-token-not-real';
const FETCHED_AT = '2026-08-21T18:00:00.000Z';
const LIVE_AS_OF = '2026-08-21';
const OBSERVED = '2026-08-21T17:55:00.000Z';
const GROCERY_POSTED = 40;
const GROCERY_PENDING = 15;
const FUEL_POSTED = 22.1;
const FUEL_PERIOD_START = '2026-08-14';
const FUEL_PERIOD_END = '2026-08-27';
const MONTH = 365.25 / 12;

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) <= eps;
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const round2 = v => Math.round(Number(v) * 100) / 100;

const liveData = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const liveHash = hashFile(DATA);
const positionsHash = fs.existsSync(POSITIONS) ? hashFile(POSITIONS) : null;
const snapshotHashes = fs.readdirSync(SNAPSHOT_DIR)
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => `${name}:${hashFile(path.join(SNAPSHOT_DIR, name))}`);

function snapshotState() {
  return fs.readdirSync(SNAPSHOT_DIR)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => `${name}:${hashFile(path.join(SNAPSHOT_DIR, name))}`);
}

function filesUnchanged(label) {
  ok(hashFile(DATA) === liveHash, `${label}: data.json bytes unchanged`);
  if (positionsHash) {
    ok(hashFile(POSITIONS) === positionsHash, `${label}: positions.csv bytes unchanged`);
  }
  const now = snapshotState();
  ok(now.length === snapshotHashes.length
    && now.every((row, i) => row === snapshotHashes[i]),
    `${label}: snapshots unchanged`);
}

function cashValue(id) {
  const rows = ((liveData.plan && liveData.plan.startingCash && liveData.plan.startingCash.breakdown) || []);
  const row = rows.find(r => r && r.id === id);
  return row ? Number(row.value) : null;
}

function debt(id) {
  return ((liveData.debts || []).find(d => d && d.id === id)) || null;
}

function syntheticLiveMap() {
  return {
    schema: 'atlas-provider-account-map/v1',
    owns: 'Synthetic production-transport test map. Fixture IDs 3001–3010 are not live provider IDs.',
    does_not_own: 'Financial values, permission to write data.json, Forecast, or live owner-observed IDs.',
    provider: 'lunchmoney',
    scope: 'live',
    mappings: [
      { providerAccountId: '3001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
      { providerAccountId: '3002', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
      { providerAccountId: '3003', canonical: { collection: 'cash', id: 'savings' }, atlasRole: 'household-reserve' },
      { providerAccountId: '3004', canonical: { collection: 'debts', id: 'tdcc' }, atlasRole: 'revolving-credit' },
      { providerAccountId: '3005', canonical: { collection: 'debts', id: 'cashback' }, atlasRole: 'revolving-credit' },
      { providerAccountId: '3006', canonical: { collection: 'debts', id: 'travelvisa' }, atlasRole: 'revolving-credit' },
      { providerAccountId: '3007', canonical: { collection: 'debts', id: 'heloc' }, atlasRole: 'heloc' },
      { providerAccountId: '3008', canonical: { collection: 'debts', id: 'mortgage' }, atlasRole: 'mortgage' },
      { providerAccountId: '3010', canonical: { collection: 'debts', id: 'triangle' }, atlasRole: 'revolving-credit' },
    ],
  };
}

function cashOnlyLiveMap() {
  return {
    schema: 'atlas-provider-account-map/v1',
    owns: 'Synthetic cash-only map for unresolved-account remaining proof.',
    does_not_own: 'Financial values, permission to write data.json, Forecast, or live owner-observed IDs.',
    provider: 'lunchmoney',
    scope: 'live',
    mappings: [
      { providerAccountId: '3001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
      { providerAccountId: '3002', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
      { providerAccountId: '3003', canonical: { collection: 'cash', id: 'savings' }, atlasRole: 'household-reserve' },
    ],
  };
}

function matchingAccounts() {
  return [
    { id: 3001, name: 'BILLS ACCOUNT', type: 'cash', subtype: 'checking', balance: cashValue('chequing-a'), updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad', institution_name: 'TD Canada Trust' },
    { id: 3002, name: 'WEEKLY SPENDING', type: 'cash', subtype: 'checking', balance: cashValue('chequing-b'), updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad', institution_name: 'TD Canada Trust' },
    { id: 3003, name: 'EMERGENCY SAVING', type: 'cash', subtype: 'savings', balance: cashValue('savings'), updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad', institution_name: 'TD Canada Trust' },
    { id: 3004, name: 'PERSONAL CREDIT CARD', type: 'credit', subtype: 'credit_card', balance: debt('tdcc').balance, credit_limit: debt('tdcc').limit, updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad' },
    { id: 3005, name: 'TD CASH BACK VISA* CARD', type: 'credit', subtype: 'credit_card', balance: debt('cashback').balance, credit_limit: debt('cashback').limit, updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad' },
    { id: 3006, name: 'TRAVEL VISA', type: 'credit', subtype: 'credit_card', balance: debt('travelvisa').balance, credit_limit: debt('travelvisa').limit, updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad' },
    { id: 3007, name: 'LINE OF CREDIT - HOME EQUITY', type: 'loan', subtype: 'line_of_credit', balance: debt('heloc').balance, updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad' },
    { id: 3008, name: 'MORTGAGE', type: 'loan', subtype: 'mortgage', balance: debt('mortgage').balance, updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad' },
    { id: 3010, name: 'TRIANGLE MASTERCARD', type: 'credit', subtype: 'credit_card', balance: debt('triangle').balance, credit_limit: debt('triangle').limit, updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad' },
  ];
}

function currentPeriodTransactions() {
  return [
    { id: 91001, account_id: 3005, date: LIVE_AS_OF, amount: GROCERY_POSTED, category_id: 11, is_pending: false, payee: 'SYNTHETIC GROCER' },
    { id: 91002, account_id: 3005, date: '2026-08-20', amount: FUEL_POSTED, category_id: 12, is_pending: false, payee: 'SYNTHETIC FUEL' },
    { id: 91003, account_id: 3005, date: LIVE_AS_OF, amount: GROCERY_PENDING, category_id: 11, is_pending: true, payee: 'SYNTHETIC PENDING GROCER' },
    { id: 91004, account_id: 3001, date: '2026-08-16', amount: 103, is_pending: false, payee: 'BCAA-AdvAutoIns INS' },
  ];
}

function isolatedEnv(extra) {
  const env = Object.assign({}, process.env);
  for (const key of Object.keys(env)) {
    if (/^(ATLAS_|LUNCHMONEY_)/.test(key)) delete env[key];
  }
  // Missing-token controls must never consult the user's Windows credential
  // store. This empty task-owned location is independent of real credentials.
  env.ATLAS_LUNCHMONEY_CREDENTIAL_FILE = path.join(require('os').tmpdir(),
    'atlas-production-overlay-no-credentials-' + process.pid, 'missing.dat');
  return Object.assign(env, extra || {});
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(err => err ? reject(err) : resolve(port));
    });
    server.on('error', reject);
  });
}

function startMockProvider(mode) {
  const cfg = mode && typeof mode === 'object' ? mode : { name: mode };
  const modeName = cfg.name || 'ok';
  const extraAccounts = cfg.extraAccounts || [];
  const extraTransactions = cfg.extraTransactions || [];
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({
      method: req.method,
      url: req.url,
      hasAuth: Boolean(req.headers.authorization),
      authLooksBearer: /^Bearer\s+\S+/.test(String(req.headers.authorization || '')),
    });
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (modeName === 'unauthorized') {
      send(401, { error: 'invalid token SECRET-SHOULD-NOT-LEAK', token: SYNTHETIC_TOKEN });
      return;
    }
    if (modeName === 'hang') return;
    if (url.pathname === '/v2/me') { send(200, { user_id: 1 }); return; }
    if (url.pathname === '/v2/plaid_accounts') {
      send(200, { plaid_accounts: matchingAccounts().concat(extraAccounts) });
      return;
    }
    if (url.pathname === '/v2/manual_accounts' || url.pathname === '/v2/assets') {
      send(200, { manual_accounts: [] });
      return;
    }
    if (url.pathname === '/v2/categories') {
      send(200, { categories: [
        { id: 11, name: 'Groceries', is_income: false },
        { id: 12, name: 'Fuel & transport', is_income: false },
      ] });
      return;
    }
    if (url.pathname === '/v2/tags') {
      send(200, { tags: [] });
      return;
    }
    if (url.pathname === '/v2/transactions') {
      const pendingUniverse = url.searchParams.get('is_pending') === 'true';
      const offset = Number(url.searchParams.get('offset') || 0);
      const txs = currentPeriodTransactions().concat(extraTransactions).map(row => ({ currency: 'cad', ...row }));
      if (pendingUniverse) {
        const pending = txs.filter(tx => tx.is_pending === true);
        send(200, { has_more: false, transactions: pending });
        return;
      }
      if (modeName === 'truncated') {
        send(200, {
          has_more: true,
          transactions: [{
            id: 92000 + offset,
            account_id: 3005,
            date: LIVE_AS_OF,
            amount: 1,
            category_id: 11,
            is_pending: false,
            payee: 'SYNTHETIC PAGE',
          }],
        });
        return;
      }
      send(200, { has_more: false, transactions: txs });
      return;
    }
    send(404, {});
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        calls,
        port: server.address().port,
        base: `http://127.0.0.1:${server.address().port}/v2`,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
    server.on('error', reject);
  });
}

function startAtlas(env) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('server start timeout\n' + stderr));
    }, 8000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!settled && /listening/.test(stdout)) {
        settled = true;
        clearTimeout(timer);
        resolve({
          child,
          stdout: () => stdout,
          stderr: () => stderr,
          stop: () => new Promise(done => {
            child.once('exit', () => done());
            child.kill('SIGTERM');
            setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* already gone */ } }, 2000);
          }),
        });
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server exited ${code}\n${stderr}`));
    });
  });
}

async function login(base) {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(PASS)}`,
  });
  const setCookie = res.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  return { status: res.status, cookie, setCookie };
}

function secretLeak(blob) {
  const text = String(blob || '');
  return /synthetic-readonly-token-not-real/.test(text)
    || /Bearer\s+synthetic/.test(text)
    || /"payee"\s*:/.test(text)
    || /"providerTransactionId"\s*:/.test(text)
    || /"providerAccountId"\s*:/.test(text)
    || /ATLAS_PROVIDER_ACCOUNT_MAP_JSON/.test(text)
    || /Authorization/.test(text);
}

async function withAtlas(envExtra, mockMode, fn) {
  const mock = mockMode == null ? null : await startMockProvider(mockMode);
  const port = await freePort();
  const env = isolatedEnv(Object.assign({
    SITE_PASSWORD: PASS,
    SESSION_SECRET: SECRET,
    PORT: String(port),
  }, mock ? {
    [O.API_BASE_ENV]: mock.base,
    ATLAS_LIVE_OVERLAY_NOW: FETCHED_AT,
  } : {}, envExtra || {}));
  const atlas = await startAtlas(env);
  try {
    return await fn({
      base: `http://127.0.0.1:${port}`,
      mock,
      atlas,
    });
  } finally {
    await atlas.stop();
    if (mock) await mock.close();
  }
}

function independentGroceryRemaining(plan, asOf) {
  const actionProbe = Forecast.currentPeriodAction(plan, asOf, {
    debts: liveData.debts,
    paydayFloor: 1000,
  });
  const groceries = ((plan.budget && plan.budget.categories) || [])
    .find(row => row && row.id === 'groceries');
  const payday = groceries && groceries.plannedPayday != null
    ? Number(groceries.plannedPayday) : null;
  const weekly = groceries && groceries.plannedWeekly != null
    ? Number(groceries.plannedWeekly) : null;
  const monthly = weekly != null
    ? round2(weekly * MONTH / 7)
    : Number(groceries && groceries.plannedMonthly);
  const needDays = Forecast.diffDays(actionProbe.periodStart, actionProbe.periodEnd) + 1;
  // Declared plannedPayday is already the Seaspan-cycle Planned figure.
  // Do not smear plannedMonthly across remaining days (L-002).
  const planned = payday != null
    ? round2(payday)
    : round2(monthly * needDays / MONTH);
  const committed = round2(GROCERY_POSTED + GROCERY_PENDING);
  return {
    planned,
    committed,
    remaining: round2(planned - committed),
    periodStart: actionProbe.periodStart,
    periodEnd: actionProbe.periodEnd,
  };
}

(async function main() {
  console.log('=== A. live config enabled uses the incumbent live path ===');
  await withAtlas({
    ATLAS_LIVE_OVERLAY: 'live',
    [O.TOKEN_ENV]: SYNTHETIC_TOKEN,
    [O.MAP_JSON_ENV]: JSON.stringify(syntheticLiveMap()),
  }, 'ok', async ({ base, mock }) => {
    const auth = await login(base);
    ok(auth.status === 302 && auth.cookie, 'login issues a session');
    const beforeCalls = mock.calls.length;
    const res = await fetch(`${base}/data.json`, { headers: { cookie: auth.cookie } });
    const data = await res.json();
    ok(res.status === 200, 'authenticated /data.json succeeds', `status ${res.status}`);
    ok(mock.calls.length > beforeCalls, 'live /data.json invoked the provider');
    ok(mock.calls.some(c => c.method === 'GET' && c.url.startsWith('/v2/me')),
      'existing observer GETs /me');
    ok(mock.calls.every(c => c.method === 'GET'), 'observer remains GET-only');
    ok(data.liveOverlay && data.liveOverlay.applied === true,
      'live overlay applied on the production path');
    ok(data.liveOverlay.writesCanonicalState === false
      && data.liveOverlay.productionWrite === false,
      'response declares no canonical or production write');
    ok(String(data.liveOverlay.effectiveAsOf) === LIVE_AS_OF,
      'effective as-of is the pinned observation date');
    ok(data.refreshTrust && data.refreshTrust.schema === RT.SCHEMA,
      'live /data.json carries the household refresh-trust packet');
    ok(RT.looksSanitized(data.refreshTrust), 'live refresh-trust packet is sanitized');
    ok(data.refreshTrust.observedAsOf === LIVE_AS_OF,
      'live packet last-observed as-of is the observation household date');
    const liveAction = Forecast.currentPeriodAction(data.plan, data.liveOverlay.effectiveAsOf, {
      debts: data.debts,
      revolvingExtra: data.revolvingExtra,
      paydayFloor: 1000,
      currentPeriodActuals: data.liveOverlay.currentPeriodActuals,
    });
    ok(data.refreshTrust.remainingClaim === liveAction.remainingClaim,
      'live packet remainingClaim copies Forecast.currentPeriodAction');
    filesUnchanged('A live success');
  });

  console.log('\n=== B. live config off stays the dated opening ===');
  await withAtlas({}, 'ok', async ({ base, mock }) => {
    const auth = await login(base);
    const before = mock.calls.length;
    const res = await fetch(`${base}/data.json`, { headers: { cookie: auth.cookie } });
    const data = await res.json();
    ok(res.status === 200, 'canonical /data.json succeeds');
    ok(mock.calls.length === before, 'no provider call when overlay is off');
    ok(!data.liveOverlay, 'no liveOverlay metadata when overlay is off');
    ok(data.refreshTrust && data.refreshTrust.refreshPath === 'dated-opening',
      'overlay-off still publishes dated-opening trust');
    ok(data.refreshTrust.displayState === 'attention-needed'
      && data.refreshTrust.exactFiguresAvailable === false,
      'dated opening without actuals is attention-needed and withholds exact remaining');
    ok(data.refreshTrust.observedAsOf == null,
      'overlay-off does not publish a last-observed date');
    ok(String(data.meta.asOf) === String(liveData.meta.asOf),
      'dated opening as-of is unchanged');
    filesUnchanged('B overlay off');
  });

  console.log('\n=== C. token missing fails closed ===');
  await withAtlas({
    ATLAS_LIVE_OVERLAY: 'live',
    [O.MAP_JSON_ENV]: JSON.stringify(syntheticLiveMap()),
  }, 'ok', async ({ base, mock, atlas }) => {
    const auth = await login(base);
    const res = await fetch(`${base}/data.json`, { headers: { cookie: auth.cookie } });
    const data = await res.json();
    ok(res.status === 200, 'missing token does not crash the server');
    ok(data.liveOverlay && data.liveOverlay.applied === false,
      'overlay is not applied');
    ok(data.liveOverlay.reason === 'live-observation-unavailable',
      'sanitized missing-token reason is published', data.liveOverlay.reason);
    ok(data.refreshTrust && data.refreshTrust.displayState === 'attention-needed',
      'fail-closed overlay publishes attention-needed trust');
    ok(data.refreshTrust.observedAsOf == null,
      'fail-closed before an observation receipt does not fabricate last-observed');
    ok(String(data.meta.asOf) === String(liveData.meta.asOf),
      'canonical opening as-of is served');
    ok(mock.calls.length === 0, 'no provider call without a token');
    ok(!secretLeak(atlas.stderr()) && !secretLeak(JSON.stringify(data)),
      'stderr and body do not print a token');
    filesUnchanged('C token missing');
  });

  console.log('\n=== D. invalid token / provider error fails closed ===');
  await withAtlas({
    ATLAS_LIVE_OVERLAY: 'live',
    [O.TOKEN_ENV]: SYNTHETIC_TOKEN,
    [O.MAP_JSON_ENV]: JSON.stringify(syntheticLiveMap()),
  }, 'unauthorized', async ({ base, atlas }) => {
    const auth = await login(base);
    const res = await fetch(`${base}/data.json`, { headers: { cookie: auth.cookie } });
    const bodyText = await res.text();
    const data = JSON.parse(bodyText);
    ok(res.status === 200, 'provider 401 does not crash /data.json');
    ok(data.liveOverlay && data.liveOverlay.applied === false,
      'overlay is not applied');
    ok(!/invalid token|SECRET-SHOULD-NOT-LEAK/.test(bodyText),
      'raw provider body does not reach the browser');
    ok(!secretLeak(bodyText) && !secretLeak(atlas.stderr()),
      'token and Authorization stay out of browser and logs');
    const health = await fetch(`${base.replace(/\/$/, '')}/healthz`);
    ok(health.status === 200 && (await health.text()) === 'ok',
      'service remains healthy after provider failure');
    filesUnchanged('D provider error');
  });

  console.log('\n=== E. private mapping JSON transport ===');
  {
    const map = syntheticLiveMap();
    ok(map.schema === O.LIVE_MAP_SCHEMA, 'transport uses atlas-provider-account-map/v1');
    const loaded = O.loadLiveAccountMap({ [O.MAP_JSON_ENV]: JSON.stringify(map) }, liveData);
    ok(loaded.mappings.find(m => m.canonical.id === 'chequing-a').providerAccountId === '3001',
      'chequing-a resolves from the JSON transport');
    ok(loaded.mappings.find(m => m.canonical.id === 'chequing-b').canonical.id === 'chequing-b',
      'chequing-b Atlas id is preserved');
    const committed = JSON.parse(fs.readFileSync(O.DEFAULT_MAP, 'utf8'));
    ok(Array.isArray(committed.mappings) && committed.mappings.length === 0,
      'committed live map remains empty; no real mapping is in git');
  }

  console.log('\n=== F. invalid mapping fails closed without display-name matching ===');
  await withAtlas({
    ATLAS_LIVE_OVERLAY: 'live',
    [O.TOKEN_ENV]: SYNTHETIC_TOKEN,
    [O.MAP_JSON_ENV]: '{not-json',
  }, 'ok', async ({ base, mock }) => {
    const auth = await login(base);
    const res = await fetch(`${base}/data.json`, { headers: { cookie: auth.cookie } });
    const data = await res.json();
    ok(data.liveOverlay && data.liveOverlay.applied === false,
      'malformed mapping fails closed');
    ok(data.liveOverlay.reason === 'live-account-map-invalid',
      'sanitized invalid-map reason', data.liveOverlay.reason);
    ok(mock.calls.length === 0, 'invalid mapping does not call the provider');
    ok(String(data.meta.asOf) === String(liveData.meta.asOf),
      'dated opening is served');
  });
  await withAtlas({
    ATLAS_LIVE_OVERLAY: 'live',
    [O.TOKEN_ENV]: SYNTHETIC_TOKEN,
    [O.MAP_JSON_ENV]: JSON.stringify({
      schema: 'atlas-provider-account-map/v1',
      provider: 'lunchmoney',
      scope: 'live',
      mappings: [
        { providerAccountId: '3001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
      ],
    }),
  }, 'ok', async ({ base, mock }) => {
    const auth = await login(base);
    const data = await (await fetch(`${base}/data.json`, { headers: { cookie: auth.cookie } })).json();
    ok(data.liveOverlay && data.liveOverlay.applied === false,
      'incomplete required cash mapping fails closed');
    ok(data.liveOverlay.reason === 'missing-required-cash-mapping',
      'missing cash mapping is named', data.liveOverlay.reason);
    ok(mock.calls.length === 0, 'incomplete mapping does not fetch provider data');
  });
  await withAtlas({
    ATLAS_LIVE_OVERLAY: 'live',
    [O.TOKEN_ENV]: SYNTHETIC_TOKEN,
    [O.MAP_JSON_ENV]: JSON.stringify({
      schema: 'atlas-provider-account-map/v1',
      provider: 'lunchmoney',
      scope: 'live',
      mappings: [
        { providerAccountId: '3001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
        { providerAccountId: '3002', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
        { providerAccountId: '3003', canonical: { collection: 'cash', id: 'savings' }, atlasRole: 'household-reserve' },
        { providerAccountId: '3999', canonical: { collection: 'debts', id: 'savings' }, atlasRole: 'revolving-credit' },
      ],
    }),
  }, 'ok', async ({ base, mock }) => {
    const auth = await login(base);
    const data = await (await fetch(`${base}/data.json`, { headers: { cookie: auth.cookie } })).json();
    ok(data.liveOverlay && data.liveOverlay.applied === false,
      'cross-collection Atlas id fails closed on /data.json');
    ok(data.liveOverlay.reason === 'invalid-atlas-account-id',
      'wrong-collection id is named', data.liveOverlay.reason);
    ok(mock.calls.length === 0, 'wrong-collection mapping does not call the provider');
    ok(String(data.meta.asOf) === String(liveData.meta.asOf),
      'dated opening is served for wrong-collection mapping');
  });
  {
    let threw = false;
    try {
      O.loadLiveAccountMap({
        [O.MAP_JSON_ENV]: JSON.stringify({
          schema: 'atlas-provider-account-map/v1',
          provider: 'lunchmoney',
          scope: 'live',
          mappings: [
            { providerAccountId: '3001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
            { providerAccountId: '3001', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
            { providerAccountId: '3003', canonical: { collection: 'cash', id: 'savings' }, atlasRole: 'household-reserve' },
          ],
        }),
      }, liveData);
    } catch (err) {
      threw = /duplicate-provider-account-id/.test(err.message);
    }
    ok(threw, 'duplicate provider IDs fail closed');
  }
  {
    let threw = false;
    try {
      O.loadLiveAccountMap({
        [O.MAP_JSON_ENV]: JSON.stringify({
          schema: 'atlas-provider-account-map/v1',
          provider: 'lunchmoney',
          scope: 'live',
          mappings: [
            { providerAccountId: '3001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
            { providerAccountId: '3002', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
            { providerAccountId: '3003', canonical: { collection: 'cash', id: 'savings' }, atlasRole: 'not-a-role' },
          ],
        }),
      }, liveData);
    } catch (err) {
      threw = /unsupported-atlas-role/.test(err.message);
    }
    ok(threw, 'unsupported roles fail closed');
  }
  {
    let threw = false;
    try {
      O.loadLiveAccountMap({
        [O.MAP_JSON_ENV]: JSON.stringify({
          schema: 'atlas-provider-account-map/v1',
          provider: 'lunchmoney',
          scope: 'live',
          mappings: [
            { providerAccountId: '3001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
            { providerAccountId: '3002', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
            { providerAccountId: '3003', canonical: { collection: 'cash', id: 'savings' }, atlasRole: 'household-reserve' },
            { providerAccountId: '3999', canonical: { collection: 'debts', id: 'savings' }, atlasRole: 'revolving-credit' },
          ],
        }),
      }, liveData);
    } catch (err) {
      threw = /invalid-atlas-account-id/.test(err.message);
    }
    ok(threw, 'cash id mapped into debts fails closed');
  }
  {
    let threw = false;
    try {
      O.loadLiveAccountMap({
        [O.MAP_JSON_ENV]: JSON.stringify({
          schema: 'atlas-provider-account-map/v1',
          provider: 'lunchmoney',
          scope: 'live',
          mappings: cashOnlyLiveMap().mappings.concat([
            { providerAccountId: '3099', atlasRole: 'household-external' },
          ]),
        }),
      }, liveData);
    } catch (err) {
      threw = true;
    }
    ok(!threw, 'explicit household-external mapping is accepted');
  }
  {
    let threw = false;
    try {
      O.loadLiveAccountMap({
        [O.MAP_JSON_ENV]: JSON.stringify({
          schema: 'atlas-provider-account-map/v1',
          provider: 'lunchmoney',
          scope: 'live',
          mappings: cashOnlyLiveMap().mappings.concat([
            {
              providerAccountId: '3099',
              canonical: { collection: 'cash', id: 'chequing-a' },
              atlasRole: 'household-external',
            },
          ]),
        }),
      }, liveData);
    } catch (err) {
      threw = /live-account-map-invalid/.test(err.message);
    }
    ok(threw, 'household-external cannot claim a canonical household identity');
  }

  console.log('\n=== G. secrets and provider ids never reach the browser ===');
  await withAtlas({
    ATLAS_LIVE_OVERLAY: 'live',
    [O.TOKEN_ENV]: SYNTHETIC_TOKEN,
    [O.MAP_JSON_ENV]: JSON.stringify(syntheticLiveMap()),
  }, 'ok', async ({ base, atlas }) => {
    const auth = await login(base);
    const bodyText = await (await fetch(`${base}/data.json`, { headers: { cookie: auth.cookie } })).text();
    ok(!secretLeak(bodyText), 'authenticated body has no token, map payload, payee, or provider ids');
    ok(!secretLeak(atlas.stderr()), 'server logs have no token or Authorization header');
    const data = JSON.parse(bodyText);
    const actuals = data.liveOverlay && data.liveOverlay.currentPeriodActuals;
    ok(actuals && actuals.schema === 'atlas-current-period-actuals/v1',
      'sanitized current-period packet is published');
    ok(!(actuals.transactions || []).some(tx =>
      tx.payee || tx.providerTransactionId || tx.providerAccountId || tx.original_name
      || tx.notes || tx.tags
      || tx.note || tx.tag || tx.merchant || tx.merchantName),
      'actuals rows dropped raw payee, notes, tags, provider ids, and renamed equivalents');
    ok((actuals.transactions || []).some(tx =>
      tx.displayedPayee === 'SYNTHETIC GROCER' || tx.originalMerchant === 'SYNTHETIC GROCER'),
      'actuals rows keep sanitized displayedPayee / originalMerchant');
    ok((actuals.transactions || []).some(tx =>
      tx.merchantKnown === true || tx.dogFood === true || tx.representedBill === true
      || tx.categoryLabel),
      'actuals rows keep derived classifications');
  });

  console.log('\n=== H. live /data.json does not write canonical files ===');
  await withAtlas({
    ATLAS_LIVE_OVERLAY: 'live',
    [O.TOKEN_ENV]: SYNTHETIC_TOKEN,
    [O.MAP_JSON_ENV]: JSON.stringify(syntheticLiveMap()),
  }, 'ok', async ({ base }) => {
    const auth = await login(base);
    await fetch(`${base}/data.json`, { headers: { cookie: auth.cookie } });
    await fetch(`${base}/data.json`, { headers: { cookie: auth.cookie } });
    filesUnchanged('H two live reads');
  });

  console.log('\n=== I. /healthz is independent of Lunch Money ===');
  await withAtlas({
    ATLAS_LIVE_OVERLAY: 'live',
    [O.TOKEN_ENV]: SYNTHETIC_TOKEN,
    [O.MAP_JSON_ENV]: JSON.stringify(syntheticLiveMap()),
  }, 'unauthorized', async ({ base, mock }) => {
    const before = mock.calls.length;
    const res = await fetch(`${base}/healthz`);
    ok(res.status === 200 && (await res.text()) === 'ok', 'healthz remains ok');
    ok(mock.calls.length === before, 'healthz does not invoke provider observation');
  });

  console.log('\n=== J. current-period actuals reach Forecast through /data.json ===');
  await withAtlas({
    ATLAS_LIVE_OVERLAY: 'live',
    [O.TOKEN_ENV]: SYNTHETIC_TOKEN,
    [O.MAP_JSON_ENV]: JSON.stringify(syntheticLiveMap()),
  }, 'ok', async ({ base }) => {
    const auth = await login(base);
    const data = await (await fetch(`${base}/data.json`, { headers: { cookie: auth.cookie } })).json();
    ok(data.liveOverlay && data.liveOverlay.applied === true, 'live packet applied for actuals');
    const actuals = data.liveOverlay.currentPeriodActuals;
    ok(actuals && actuals.transactionCoverage === 'complete',
      'posted window is complete');
    ok(actuals.pendingCoverage === 'complete', 'pending coverage is complete');
    const groceryTx = (actuals.transactions || []).find(tx =>
      tx.categoryLabel === 'Groceries' && tx.pending !== true && Number(tx.amount) === GROCERY_POSTED);
    const pendingTx = (actuals.transactions || []).find(tx =>
      tx.categoryLabel === 'Groceries' && tx.pending === true && Number(tx.amount) === GROCERY_PENDING);
    const fuelTx = (actuals.transactions || []).find(tx =>
      tx.categoryLabel === 'Fuel & transport' && Number(tx.amount) === FUEL_POSTED);
    ok(groceryTx && groceryTx.accountRole === 'revolving-credit',
      'posted grocery reaches the sanitized packet');
    ok(pendingTx && pendingTx.pendingTreatment === 'unresolved',
      'known pending grocery is preserved');
    ok(fuelTx, 'posted fuel reaches the sanitized packet');
    ok((actuals.representedActuals || []).some(row =>
      (row.id === 'bcaa-aug15-outstanding' || row.id === 'bcaa') && near(row.actual, 103)),
      'BCAA identity evidence is represented without using amount as identity');
    ok(!(actuals.representedActuals || []).some(row => /resp|cmaw/i.test(String(row.id || ''))),
      'RESP / CMAW are not guessed');
    const asOf = data.liveOverlay.effectiveAsOf;
    const expected = independentGroceryRemaining(data.plan, asOf);
    const action = Forecast.currentPeriodAction(data.plan, asOf, {
      debts: data.debts,
      revolvingExtra: data.revolvingExtra,
      paydayFloor: 1000,
      currentPeriodActuals: actuals,
    });
    const grocery = (action.categories || []).find(row => row.id === 'groceries');
    ok(grocery, 'Forecast publishes a groceries row from the live packet');
    ok(near(grocery.planned, expected.planned),
      'grocery planned matches independent payday-cycle Planned (not monthly smear)',
      `${grocery.planned} vs ${expected.planned}`);
    ok(near(grocery.committed, expected.committed),
      'grocery committed is posted $40 + pending $15',
      String(grocery.committed));
    ok(near(grocery.remaining, expected.remaining),
      'grocery remaining matches independent planned − committed',
      `${grocery.remaining} vs ${expected.remaining}`);
    const fuel = (action.categories || []).find(row => row.id === 'fuel');
    const fuelCat = ((data.plan.budget && data.plan.budget.categories) || [])
      .find(row => row && row.id === 'fuel');
    ok(asOf === LIVE_AS_OF && action.periodStart === FUEL_PERIOD_START
        && action.periodEnd === FUEL_PERIOD_END,
      'fuel remaining oracle is bounded to the literal August 14-27 cycle');
    // Select the declared owner row by this fixture's literal period boundary;
    // reading the October restatement directly would backdate 555 to August.
    const fuelPolicy = fuelCat && fuelCat.targetEffectiveFrom
      && FUEL_PERIOD_START < fuelCat.targetEffectiveFrom
      ? (fuelCat.targetHistory || []).find(row => FUEL_PERIOD_START <= row.effectiveThrough)
      : fuelCat;
    const fuelNeedDays = 14;
    const fuelPlanned = fuelPolicy && fuelPolicy.plannedPayday != null
      ? round2(Number(fuelPolicy.plannedPayday))
      : round2(Number(fuelPolicy && fuelPolicy.plannedMonthly) * fuelNeedDays / MONTH);
    ok(fuel && near(fuel.committed, FUEL_POSTED),
      'fuel committed is the fixture $22.10');
    ok(fuel && near(fuel.remaining, round2(fuelPlanned - FUEL_POSTED)),
      'fuel remaining matches independent payday-cycle Planned minus committed',
      fuel ? `${fuel.remaining} vs ${round2(fuelPlanned - FUEL_POSTED)}` : 'missing');
    ok(action.remainingClaim === 'precise' || action.remainingClaim === 'posted-only',
      'Forecast remaining claim is available on complete coverage',
      action.remainingClaim);
  });

  console.log('\n=== K. truncated provider paging fails closed for remaining ===');
  await withAtlas({
    ATLAS_LIVE_OVERLAY: 'live',
    [O.TOKEN_ENV]: SYNTHETIC_TOKEN,
    [O.MAP_JSON_ENV]: JSON.stringify(syntheticLiveMap()),
  }, 'truncated', async ({ base, mock }) => {
    const auth = await login(base);
    const data = await (await fetch(`${base}/data.json`, { headers: { cookie: auth.cookie } })).json();
    const txCalls = mock.calls.filter(c => String(c.url).startsWith('/v2/transactions')
      && /include_pending=true/.test(c.url));
    ok(txCalls.length >= 2, 'production path pages the bounded transaction window',
      `${txCalls.length} pages`);
    if (data.liveOverlay && data.liveOverlay.applied === true) {
      const actuals = data.liveOverlay.currentPeriodActuals;
      ok(actuals && actuals.transactionCoverage === 'truncated',
        'truncated posted pages are published as truncated coverage');
      const action = Forecast.currentPeriodAction(data.plan, data.liveOverlay.effectiveAsOf, {
        debts: data.debts,
        paydayFloor: 1000,
        currentPeriodActuals: actuals,
      });
      ok(action.remainingClaim === 'unavailable',
        'Forecast cannot claim precise remaining from a truncated window');
    } else {
      ok(data.liveOverlay && data.liveOverlay.applied === false,
        'truncated paging may fail closed rather than mix partial live evidence');
    }
    ok(data.refreshTrust && data.refreshTrust.exactFiguresAvailable === false
      && data.refreshTrust.displayState === 'attention-needed',
      'truncated remaining cannot look precise on the household trust strip');
    filesUnchanged('K truncated paging');
  });

  console.log('\n=== L. unauthenticated requests cannot read live data ===');
  await withAtlas({
    ATLAS_LIVE_OVERLAY: 'live',
    [O.TOKEN_ENV]: SYNTHETIC_TOKEN,
    [O.MAP_JSON_ENV]: JSON.stringify(syntheticLiveMap()),
  }, 'ok', async ({ base, mock }) => {
    const before = mock.calls.length;
    const res = await fetch(`${base}/data.json`, { redirect: 'manual' });
    const body = await res.text();
    ok(res.status === 401, 'unauthenticated /data.json is 401', `status ${res.status}`);
    ok(!/liveOverlay|currentPeriodActuals|chequing-a/.test(body),
      'unauthenticated body has no live overlay or actuals');
    ok(mock.calls.length === before,
      'unauthenticated /data.json does not observe Lunch Money');
    ok(!secretLeak(body), '401 body has no secrets');
  });

  console.log('\n=== M. unresolved current-period account cannot claim precise remaining ===');
  await withAtlas({
    ATLAS_LIVE_OVERLAY: 'live',
    [O.TOKEN_ENV]: SYNTHETIC_TOKEN,
    [O.MAP_JSON_ENV]: JSON.stringify(cashOnlyLiveMap()),
  }, 'ok', async ({ base }) => {
    const auth = await login(base);
    const data = await (await fetch(`${base}/data.json`, { headers: { cookie: auth.cookie } })).json();
    ok(cashOnlyLiveMap().mappings.length === 3, 'three required cash mappings are present');
    ok(!(cashOnlyLiveMap().mappings || []).some(m => String(m.providerAccountId) === '3005'),
      'household credit-card provider account 3005 is omitted from the map');
    const actuals = data.liveOverlay && data.liveOverlay.currentPeriodActuals;
    const groceryTx = ((actuals && actuals.transactions) || []).find(tx =>
      tx.categoryLabel === 'Groceries' && tx.pending !== true && Number(tx.amount) === GROCERY_POSTED);
    ok(groceryTx && groceryTx.accountRole === 'unmapped',
      'grocery on the omitted credit card is unresolved, not household-external');
    ok(actuals && actuals.transactionCoverage === 'incomplete',
      'unmapped current-period account makes posted coverage incomplete');
    const asOf = (data.liveOverlay && data.liveOverlay.effectiveAsOf)
      || (data.meta && data.meta.asOf);
    const action = Forecast.currentPeriodAction(data.plan, asOf, {
      debts: data.debts,
      revolvingExtra: data.revolvingExtra,
      paydayFloor: 1000,
      currentPeriodActuals: actuals,
    });
    const grocery = (action.categories || []).find(row => row.id === 'groceries');
    ok(action.remainingClaim === 'unavailable',
      'Forecast will not claim precise remaining that ignores the omitted card',
      action.remainingClaim);
    ok(grocery && grocery.remaining == null,
      'no precise grocery remaining is published from an unresolved account');
  });

  const EXTERNAL_GROCERY = 99;
  const explicitExternalMap = {
    schema: 'atlas-provider-account-map/v1',
    owns: 'Synthetic map with an explicit non-household account.',
    does_not_own: 'Financial values, permission to write data.json, Forecast, or live owner-observed IDs.',
    provider: 'lunchmoney',
    scope: 'live',
    mappings: syntheticLiveMap().mappings.concat([
      { providerAccountId: '3099', atlasRole: 'household-external' },
    ]),
  };
  await withAtlas({
    ATLAS_LIVE_OVERLAY: 'live',
    [O.TOKEN_ENV]: SYNTHETIC_TOKEN,
    [O.MAP_JSON_ENV]: JSON.stringify(explicitExternalMap),
  }, {
    name: 'ok',
    extraAccounts: [{
      id: 3099, name: 'SYNTHETIC NON-HOUSEHOLD', type: 'cash', subtype: 'checking',
      balance: 10, updated_at: OBSERVED, balance_last_update: OBSERVED, currency: 'cad',
    }],
    extraTransactions: [{
      id: 91999, account_id: 3099, date: LIVE_AS_OF, amount: EXTERNAL_GROCERY,
      category_id: 11, is_pending: false, payee: 'SYNTHETIC EXTERNAL GROCER',
    }],
  }, async ({ base }) => {
    const auth = await login(base);
    const data = await (await fetch(`${base}/data.json`, { headers: { cookie: auth.cookie } })).json();
    ok(data.liveOverlay && data.liveOverlay.applied === true,
      'explicit household-external does not block the overlay');
    const actuals = data.liveOverlay.currentPeriodActuals;
    const externalTx = ((actuals && actuals.transactions) || []).find(tx =>
      Number(tx.amount) === EXTERNAL_GROCERY);
    ok(externalTx && externalTx.accountRole === 'household-external',
      'deliberately excluded account is household-external, not unmapped');
    ok(actuals && actuals.transactionCoverage === 'complete',
      'explicit exclusion keeps posted coverage complete');
    const asOf = data.liveOverlay.effectiveAsOf;
    const expected = independentGroceryRemaining(data.plan, asOf);
    const action = Forecast.currentPeriodAction(data.plan, asOf, {
      debts: data.debts,
      revolvingExtra: data.revolvingExtra,
      paydayFloor: 1000,
      currentPeriodActuals: actuals,
    });
    const grocery = (action.categories || []).find(row => row.id === 'groceries');
    ok(action.remainingClaim === 'precise' || action.remainingClaim === 'posted-only',
      'explicit exclusion does not remove remaining claim',
      action.remainingClaim);
    ok(grocery && near(grocery.committed, expected.committed),
      'excluded grocery is not counted as household spend',
      `${grocery && grocery.committed} vs ${expected.committed}`);
    ok(grocery && near(grocery.remaining, expected.remaining),
      'household grocery remaining ignores the excluded account',
      `${grocery && grocery.remaining} vs ${expected.remaining}`);
    ok(!near(grocery.committed, expected.committed + EXTERNAL_GROCERY),
      'the $99 excluded grocery is not absorbed into committed');
  });

  console.log('\n=== Render blueprint has no secret values ===');
  {
    const render = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
    ok(/key:\s*ATLAS_LIVE_OVERLAY[\s\S]*?value:\s*"live"/.test(render),
      'production enables ATLAS_LIVE_OVERLAY=live');
    ok(/key:\s*LUNCHMONEY_ACCESS_TOKEN[\s\S]{0,40}sync:\s*false/.test(render),
      'token is owner-supplied sync:false');
    ok(/key:\s*ATLAS_PROVIDER_ACCOUNT_MAP_JSON[\s\S]{0,40}sync:\s*false/.test(render),
      'account-map JSON is owner-supplied sync:false');
    ok(!/type:\s*(cron|worker)/.test(render) && !/schedule:\s*['"]/.test(render),
      'no scheduler or worker is declared');
    ok(/healthCheckPath:\s*\/healthz/.test(render), 'health check stays /healthz');
  }

  if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll production live-overlay boundary checks passed.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
