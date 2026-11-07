'use strict';
/* Read-only assistant interface.
 *
 * Proves GET /assistant/current keeps its dedicated static Bearer boundary and
 * POST /assistant/mcp uses a separate OAuth protected-resource boundary over
 * the same incumbent Forecast / live-overlay / periods packet. Both fail
 * closed, never write, and do not weaken browser session auth.
 *
 * Financial figures are reconciled against Forecast on the same served
 * data, plus an independent sum of spendable cash rows. Live household
 * cents are not copied into assertions as the specification.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Forecast = require('../public/forecast.js');
const LivePlan = require('../scripts/live-plan.js');
const Assistant = require('../scripts/assistant-packet.js');
const AssistantMcp = require('../scripts/assistant-mcp.js');
const AssistantOAuth = require('../scripts/assistant-oauth.js');
const LunchMoney = require('../scripts/assistant-lunchmoney.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const O = require('../scripts/provider-observe.js');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');
const POSITIONS = path.join(ROOT, 'docs', 'positions.csv');
const SNAPSHOT_DIR = path.join(ROOT, 'snapshots');
const QUESTIONS = path.join(ROOT, 'docs', '01_OPEN_QUESTIONS.md');
const PASS = 'synthetic-site-password';
const SECRET = 'synthetic-session-secret';
const ASSISTANT_TOKEN = 'synthetic-assistant-token-32chars!!';
const WRONG_TOKEN = 'wrong-assistant-token-32chars!!!!';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const clone = value => JSON.parse(JSON.stringify(value));
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

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

function independentSpendable(plan) {
  const rows = ((plan && plan.startingCash && plan.startingCash.breakdown) || []);
  if (!rows.length) return Number(plan && plan.startingCash && plan.startingCash.amount) || 0;
  const chequing = rows.filter(row => row && (row.id === 'chequing-a' || row.id === 'chequing-b'));
  if (chequing.length) {
    return chequing.reduce((sum, row) => sum + (Number(row.value) || 0), 0);
  }
  return rows.reduce((sum, row) => {
    if (!row || row.id === 'savings') return sum;
    return sum + (Number(row.value) || 0);
  }, 0);
}

function syntheticObligationData(planPatch) {
  const asOf = '2026-08-24';
  return {
    plan: Object.assign({
      windowDays: 21,
      opening: { asOf },
      defaults: { targetBuffer: 0 },
      startingCash: {
        amount: 8000,
        breakdown: [{ id: 'cheq', label: 'Chequing', value: 8000 }],
      },
      income: [{
        id: 'pay',
        label: 'Payroll',
        frequency: 'once',
        date: '2026-08-28',
        amount: 2500,
        confidence: 'confirmed',
      }],
      obligations: [],
      bills: [],
      commitments: [],
    }, planPatch || {}),
    debts: [],
    meta: { asOf },
  };
}

// A joint-cash outflow dated before as-of is on the stream only while the
// walk still owes it; it is due today (overdue). Anything else keeps its date.
function earliestNamedOutflow(events, asOf) {
  let best = null;
  let bestDate = null;
  for (const event of events || []) {
    if (!(event.amount < 0) || event.kind === 'noncash') continue;
    const due = event.date >= asOf ? event.date : event.jointCash !== false ? asOf : null;
    if (due == null) continue;
    if (!best || due < bestDate) { best = event; bestDate = due; }
  }
  return best;
}

function sameDayJointCashOutflows(events, asOf, date) {
  return (events || []).filter(event =>
    event.amount < 0
    && event.kind !== 'noncash'
    && event.jointCash !== false
    && event.date >= asOf
    && event.date === date
  );
}

function forbiddenBlob(value) {
  const text = JSON.stringify(value == null ? {} : value);
  return /"providerAccountId"\s*:/.test(text)
    || /"providerTransactionId"\s*:/.test(text)
    || /"payee"\s*:/.test(text)
    || /"original_name"\s*:/.test(text)
    || /Bearer\s+\S+/.test(text)
    || /LUNCHMONEY_ACCESS_TOKEN/.test(text)
    || /SITE_PASSWORD/.test(text)
    || /SESSION_SECRET/.test(text)
    || /ATLAS_ASSISTANT_TOKEN/.test(text)
    || /ATLAS_TALK_GEMINI_API_KEY/.test(text)
    || /ATLAS_PROVIDER_ACCOUNT_MAP_JSON/.test(text)
    || /synthetic-site-password/.test(text)
    || /synthetic-session-secret/.test(text)
    || /synthetic-assistant-token/.test(text)
    || /synthetic-readonly-token/.test(text);
}

function isolatedEnv(extra) {
  const env = Object.assign({}, process.env);
  for (const key of Object.keys(env)) {
    if (/^(ATLAS_|LUNCHMONEY_)/.test(key)) delete env[key];
  }
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
  return { status: res.status, cookie: setCookie.split(';')[0], setCookie };
}

async function withAtlas(envExtra, fn) {
  const port = await freePort();
  const env = isolatedEnv(Object.assign({
    SITE_PASSWORD: PASS,
    SESSION_SECRET: SECRET,
    PORT: String(port),
  }, envExtra || {}));
  const atlas = await startAtlas(env);
  try {
    return await fn({
      base: `http://127.0.0.1:${port}`,
      atlas,
    });
  } finally {
    await atlas.stop();
  }
}

async function startOAuthIssuer() {
  const jose = await import('jose');
  const pair = await jose.generateKeyPair('RS256', { extractable: true });
  const publicJwk = await jose.exportJWK(pair.publicKey);
  publicJwk.kid = 'atlas-test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const otherPair = await jose.generateKeyPair('RS256', { extractable: true });
  let issuer;
  // Synthetic authorization codes / refresh tokens for the SDK step-up proof.
  // Granted scope = requested ∩ assigned, like an RBAC issuer; refresh never
  // widens scope.
  const codes = new Map();
  const refreshTokens = new Map();
  const tokenRequests = [];
  let sequence = 0;
  async function tokenResponse(grant) {
    const body = {
      access_token: await sign(grant.resource, { scope: grant.scope }),
      token_type: 'Bearer',
      expires_in: 300,
      scope: grant.scope,
    };
    if (grant.refresh) {
      const refreshToken = `synthetic-refresh-${++sequence}`;
      refreshTokens.set(refreshToken, grant);
      body.refresh_token = refreshToken;
    }
    return body;
  }
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/token') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const grantType = form.get('grant_type');
        tokenRequests.push(grantType);
        const grant = grantType === 'authorization_code' ? codes.get(form.get('code'))
          : grantType === 'refresh_token' ? refreshTokens.get(form.get('refresh_token'))
            : null;
        if (grantType === 'authorization_code') codes.delete(form.get('code'));
        if (!grant || (grantType === 'authorization_code' && !form.get('code_verifier'))) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: 'invalid_grant' }));
        }
        return res.end(JSON.stringify(await tokenResponse(grant)));
      });
      return undefined;
    }
    if (req.url === '/.well-known/oauth-authorization-server') {
      return res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        jwks_uri: `${issuer}jwks`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: [AssistantMcp.REQUIRED_SCOPE],
      }));
    }
    if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [publicJwk] }));
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });
  issuer = `http://127.0.0.1:${server.address().port}/`;
  async function sign(resource, overrides) {
    overrides = overrides || {};
    const now = Math.floor(Date.now() / 1000);
    const key = overrides.key || pair.privateKey;
    const claims = {
      scope: overrides.scope === undefined ? AssistantMcp.REQUIRED_SCOPE : overrides.scope,
      client_id: 'chatgpt-test-client',
      sub: 'atlas-owner-test',
    };
    if (overrides.permissions !== undefined) claims.permissions = overrides.permissions;
    return new jose.SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'atlas-test-key' })
      .setIssuer(overrides.issuer || issuer)
      .setAudience(overrides.audience || resource)
      .setIssuedAt(now)
      .setNotBefore(overrides.notBefore === undefined ? now - 1 : overrides.notBefore)
      .setExpirationTime(overrides.expiresAt === undefined ? now + 300 : overrides.expiresAt)
      .sign(key);
  }
  function grantScope(requested, assigned) {
    const asked = String(requested || '').split(/\s+/).filter(Boolean);
    return (assigned ? asked.filter(scope => assigned.includes(scope)) : asked).join(' ');
  }
  // Simulates the user approving an authorization request: returns a code
  // bound to requested ∩ assigned scope for this resource.
  function issueCode(requestedScope, resource, opts) {
    opts = opts || {};
    const code = `synthetic-code-${++sequence}`;
    codes.set(code, { scope: grantScope(requestedScope, opts.assigned), resource,
      refresh: opts.refresh === true });
    return code;
  }
  async function issueTokens(scope, resource, opts) {
    return tokenResponse({ scope, resource, refresh: !!(opts && opts.refresh) });
  }
  return {
    issuer,
    jwksUri: `${issuer}jwks`,
    otherPrivateKey: otherPair.privateKey,
    sign,
    issueCode,
    issueTokens,
    tokenRequests: () => tokenRequests.slice(),
    close: () => new Promise(done => server.close(() => done())),
  };
}

async function startLunchMoneyStub() {
  let tx = {
    id: 71, date: '2026-10-01', amount: '19.9900', currency: 'cad',
    payee: 'Synthetic Shop', notes: null, category_id: 3,
    plaid_account_id: 4, manual_account_id: null, is_pending: false, status: 'reviewed',
  };
  const categories = [{ id: 3, name: 'Groceries' }, { id: 8, name: 'Household' }];
  let hits = 0; let writes = 0; let transactionFailure = false;
  const server = http.createServer((req, res) => {
    hits += 1;
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname.replace(/^\/v2/, '') || '/';
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let body = {};
      if (chunks.length) {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = {}; }
      }
      let data;
      if (req.method === 'GET' && p === '/categories') data = { categories };
      else if (req.method === 'GET' && p.startsWith('/categories/')) {
        data = categories.find(c => c.id === Number(p.split('/').pop()));
      } else if (req.method === 'GET' && p === '/plaid_accounts') {
        data = { plaid_accounts: [
          { id: 4, name: 'Bank', type: 'depository', subtype: 'checking',
            balance: '-50.2500', currency: 'cad', balance_last_update: '2026-10-01T18:00:00Z' },
          { id: 5, name: 'EMERGENCY SAVING', type: 'depository', subtype: 'savings',
            balance: '1234.5678', currency: 'cad', balance_last_update: '2026-10-01T18:00:00Z',
            last_fetch: '2026-10-02T18:00:00Z' },
        ] };
      } else if (req.method === 'GET' && p === '/manual_accounts') {
        data = { manual_accounts: [{ id: 4, name: 'Manual card', type: 'credit',
          balance: '800.0000', currency: 'usd', balance_as_of: '2026-08-18',
          updated_at: '2026-10-02T18:00:00Z', balance_last_update: '2026-10-02T18:00:00Z' }] };
      } else if (req.method === 'GET' && p === '/transactions') {
        if (transactionFailure) {
          res.statusCode = 429;
          res.end(JSON.stringify({ error: 'synthetic-private-ledger-and-token' }));
          return;
        }
        data = { transactions: [tx], has_more: false };
      } else if (req.method === 'GET' && p.startsWith('/transactions/')) {
        data = tx;
      } else if (req.method === 'PUT' && p.startsWith('/transactions/')) {
        writes += 1;
        Object.assign(tx, body);
        data = tx;
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(data));
    });
  });
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });
  return {
    base: `http://127.0.0.1:${server.address().port}/v2`,
    hits: () => hits,
    writes: () => writes,
    resetHits: () => { hits = 0; },
    failTransactions: value => { transactionFailure = value; },
    close: () => new Promise(done => server.close(() => done())),
  };
}

async function withOfficialMcp(resource, token, fn) {
  const client = new Client({ name: 'atlas-oauth-proof', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

// A write-tool call without atlas.transactions.write must be refused at HTTP
// (403 insufficient_scope) before MCP dispatch. Without an auth provider the
// official client surfaces that as StreamableHTTPError 403.
async function httpRefusal(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

async function withOAuthAtlas(fn) {
  const oauth = await startOAuthIssuer();
  const lunchMoney = await startLunchMoneyStub();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const resource = `${base}/assistant/mcp`;
  const atlas = await startAtlas(isolatedEnv({
    SITE_PASSWORD: PASS,
    SESSION_SECRET: SECRET,
    ATLAS_ASSISTANT_TOKEN: ASSISTANT_TOKEN,
    ATLAS_MCP_RESOURCE_URL: resource,
    ATLAS_OAUTH_ISSUER: oauth.issuer,
    ATLAS_OAUTH_JWKS_URI: oauth.jwksUri,
    LUNCHMONEY_ACCESS_TOKEN: 'synthetic-readonly-token-not-real',
    ATLAS_LUNCHMONEY_API_BASE: lunchMoney.base,
    PORT: String(port),
  }));
  try {
    await fn({ base, resource, oauth, atlas, lunchMoney });
  } finally {
    await atlas.stop();
    await oauth.close();
    await lunchMoney.close();
  }
}

function expectExit(envExtra) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: isolatedEnv(Object.assign({
        SITE_PASSWORD: PASS,
        SESSION_SECRET: SECRET,
        PORT: '0',
      }, envExtra || {})),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('expected process exit, still running\n' + stderr));
    }, 5000);
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

function adviceFor(data, periods) {
  const asOf = (data.liveOverlay && data.liveOverlay.applied === true
    && data.liveOverlay.effectiveAsOf)
    || (data.plan && data.plan.opening && data.plan.opening.asOf)
    || (data.meta && data.meta.asOf);
  const actuals = data.liveOverlay && data.liveOverlay.applied === true
    ? data.liveOverlay.currentPeriodActuals
    : null;
  return Forecast.recommend(data.plan, asOf, {
    fundingSources: data.plan.funding && data.plan.funding.options,
    debts: data.debts,
    revolvingExtra: data.revolvingExtra,
    periods: periods || null,
    currentPeriodActuals: actuals,
  });
}

async function main() {
console.log('=== packet builder consumes Forecast, not a second planner ===');
{
  const periods = Assistant.loadPeriods();
  const packet = Assistant.buildPacket({
    data: clone(liveData),
    periods,
    questionsMarkdown: fs.readFileSync(QUESTIONS, 'utf8'),
    now: '2026-08-24T12:00:00.000Z',
    env: { ATLAS_GIT_SHA: '72567904bef9f5d4341a80a211db64d1411691cd' },
  });
  const advice = adviceFor(liveData, periods);
  const spendable = independentSpendable(liveData.plan);
  ok(packet.schema === Assistant.SCHEMA, 'schema is atlas-assistant-packet/v1');
  ok(packet.writesCanonicalState === false, 'packet declares no canonical write');
  ok(packet.productionWrite === false, 'packet declares no production write');
  ok(packet.authority && packet.authority.planner === 'Forecast',
    'planner authority is Forecast');
  ok(packet.current.spendableHouseholdCash.status === 'ok'
    && near(packet.current.spendableHouseholdCash.value, spendable),
    'spendable cash equals independent breakdown sum',
    `${packet.current.spendableHouseholdCash.value} vs ${spendable}`);
  ok(near(packet.current.spendableHouseholdCash.value,
    Forecast.startingCashAmount(liveData.plan)),
    'spendable cash equals Forecast.startingCashAmount');
  ok(packet.forecast.status === 'ok'
    && near(packet.forecast.recommendation.weekly, advice.weekly),
    'weekly cap equals Forecast.recommend, not a local substitute',
    `${packet.forecast.recommendation.weekly} vs ${advice.weekly}`);
  ok(packet.forecast.recommendation.mode === advice.mode,
    'recommendation mode is the Forecast mode');
  const mutated = clone(liveData);
  const cashRow = mutated.plan.startingCash.breakdown.find(row => row.id === 'chequing-a');
  cashRow.value = Number(cashRow.value) + 40;
  const mutatedPacket = Assistant.buildPacket({
    data: mutated,
    periods,
    questionsMarkdown: '',
    now: '2026-08-24T12:00:00.000Z',
    env: {},
  });
  const mutatedSum = independentSpendable(mutated.plan);
  ok(near(mutatedPacket.current.spendableHouseholdCash.value, mutatedSum)
    && !near(mutatedPacket.current.spendableHouseholdCash.value, spendable),
    'mutating chequing-a moves the packet with the independent sum',
    `${mutatedPacket.current.spendableHouseholdCash.value} vs ${mutatedSum}`);
  const weeklyMutated = clone(liveData);
  weeklyMutated.plan.defaults = Object.assign({}, weeklyMutated.plan.defaults, {
    targetBuffer: Number(weeklyMutated.plan.defaults.targetBuffer || 0) + 250,
  });
  const weeklyPacket = Assistant.buildPacket({
    data: weeklyMutated,
    periods,
    questionsMarkdown: '',
    now: '2026-08-24T12:00:00.000Z',
    env: {},
  });
  const weeklyAdvice = adviceFor(weeklyMutated, periods);
  ok(near(weeklyPacket.forecast.recommendation.weekly, weeklyAdvice.weekly),
    'a buffer mutation moves the packet weekly with Forecast.recommend',
    `${weeklyPacket.forecast.recommendation.weekly} vs ${weeklyAdvice.weekly}`);
  ok(Assistant.looksSanitized(packet) && !forbiddenBlob(packet),
    'packet has no secrets, provider ids, payees, or raw transaction keys');
  ok(!Array.isArray(packet.actuals && packet.actuals.transactions),
    'packet does not include a raw transaction list');
  const q2 = (packet.uncertainty.ownerQuestions || []).find(q => q.id === 'Q2');
  const q20 = (packet.uncertainty.ownerQuestions || []).find(q => q.id === 'Q20');
  ok(!q2, 'Q2 is ANSWERED and is not in unresolved ownerQuestions');
  ok(q20 && q20.status === 'OPEN',
    'owner questions come from 01_OPEN_QUESTIONS.md (Q20 stays OPEN)');
  ok(packet.metadata.version.gitSha === '72567904bef9f5d4341a80a211db64d1411691cd',
    'version identifier is the supplied git SHA when present');
  const posture = packet.policy && packet.policy.decisionPosture;
  ok(posture && posture.status === 'ok'
      && posture.posture === 'aggressive-not-brittle'
      && posture.numericThreshold === 'none'
      && posture.forecastApplication === 'not-applied-this-slice'
      && posture.provenance === 'owner-stated'
      && posture.provenanceDate === '2026-09-14',
    'packet projects owner decisionPosture labels without a numeric threshold');
  ok(packet.planning
      && packet.planning.trajectory
      && packet.planning.trajectory.status === 'ready'
      && packet.planning.trajectory.source === 'Forecast.baselineTrajectory'
      && Array.isArray(packet.planning.trajectory.months)
      && packet.planning.trajectory.months.length > 0,
    'packet projects Forecast.baselineTrajectory for Planning parity');
  ok(packet.authority.planner === 'Forecast'
      && /not a second planner/.test(packet.authority.note),
    'adding the policy projection does not create a second planner');
  const liveAsOf = (liveData.liveOverlay && liveData.liveOverlay.applied === true
    && liveData.liveOverlay.effectiveAsOf)
    || (liveData.plan && liveData.plan.opening && liveData.plan.opening.asOf)
    || (liveData.meta && liveData.meta.asOf);
  const liveEvents = advice.sim && advice.sim.events;
  const liveNextDue = liveEvents ? Forecast.nextDue(liveEvents, liveAsOf) : null;
  const liveNextSource = earliestNamedOutflow(liveEvents, liveAsOf);
  if (liveNextDue && liveNextSource) {
    ok(packet.current.nextSignificantObligations.nextDue.confidence === liveNextSource.confidence,
      'live nextDue confidence matches the source Forecast event',
      `${packet.current.nextSignificantObligations.nextDue.confidence} vs ${liveNextSource.confidence}`);
  }
  const liveNextOut = liveEvents ? Forecast.nextPaymentOut(liveEvents, liveAsOf) : null;
  if (liveNextOut) {
    const dayEvents = sameDayJointCashOutflows(liveEvents, liveAsOf, liveNextOut.date);
    const dayHasEstimated = dayEvents.some(event => event.confidence === 'estimated');
    const packetOut = packet.current.nextSignificantObligations.nextPaymentOut;
    if (dayHasEstimated) {
      ok(packetOut && packetOut.confidence === 'estimated',
        'live grouped nextPaymentOut stays estimated when a constituent is estimated',
        packetOut && packetOut.confidence);
    }
    ok(packetOut && packetOut.confidence !== 'confirmed' || !dayHasEstimated,
      'live grouped nextPaymentOut is not promoted to confirmed when a constituent is estimated');
  }
}

console.log('\n=== projected obligations keep source confidence ===');
{
  const estimatedData = syntheticObligationData({
    bills: [{
      id: 'est-hydro',
      label: 'Estimated hydro',
      frequency: 'once',
      date: '2026-08-26',
      amount: 120,
      confidence: 'estimated',
    }],
  });
  const estimatedPacket = Assistant.buildPacket({
    data: estimatedData,
    periods: null,
    questionsMarkdown: '',
    now: '2026-08-24T12:00:00.000Z',
    env: {},
  });
  const estimatedAdvice = adviceFor(estimatedData, null);
  const estimatedAsOf = estimatedData.plan.opening.asOf;
  const estimatedEvents = estimatedAdvice.sim.events;
  const estimatedSource = earliestNamedOutflow(estimatedEvents, estimatedAsOf);
  const packetDue = estimatedPacket.current.nextSignificantObligations.nextDue;
  const packetOut = estimatedPacket.current.nextSignificantObligations.nextPaymentOut;
  ok(estimatedSource && estimatedSource.confidence === 'estimated',
    'independent Forecast event for the synthetic next due is estimated',
    estimatedSource && estimatedSource.confidence);
  ok(packetDue && packetDue.confidence === 'estimated',
    'estimated nextDue remains estimated in the packet',
    packetDue && packetDue.confidence);
  ok(packetDue.confidence !== 'confirmed',
    'projection does not promote estimated nextDue to confirmed');
  ok(packetOut && packetOut.confidence === 'estimated',
    'estimated nextPaymentOut remains estimated in the packet',
    packetOut && packetOut.confidence);

  const mixedData = syntheticObligationData({
    bills: [
      {
        id: 'est-bill',
        label: 'Estimated bill',
        frequency: 'once',
        date: '2026-08-26',
        amount: 80,
        confidence: 'estimated',
      },
      {
        id: 'conf-bill',
        label: 'Confirmed bill',
        frequency: 'once',
        date: '2026-08-26',
        amount: 40,
        confidence: 'confirmed',
      },
    ],
  });
  const mixedPacket = Assistant.buildPacket({
    data: mixedData,
    periods: null,
    questionsMarkdown: '',
    now: '2026-08-24T12:00:00.000Z',
    env: {},
  });
  const mixedAdvice = adviceFor(mixedData, null);
  const mixedAsOf = mixedData.plan.opening.asOf;
  const mixedOut = Forecast.nextPaymentOut(mixedAdvice.sim.events, mixedAsOf);
  const mixedDay = sameDayJointCashOutflows(mixedAdvice.sim.events, mixedAsOf, mixedOut.date);
  ok(mixedDay.some(event => event.confidence === 'estimated')
    && mixedDay.some(event => event.confidence === 'confirmed'),
    'independent same-day stream mixes estimated and confirmed outflows');
  ok(mixedPacket.current.nextSignificantObligations.nextPaymentOut.confidence === 'estimated',
    'grouped nextPaymentOut uses the weaker estimated confidence',
    mixedPacket.current.nextSignificantObligations.nextPaymentOut.confidence);
  ok(mixedPacket.current.nextSignificantObligations.nextPaymentOut.confidence !== 'confirmed',
    'grouped projection cannot promote an estimated constituent to confirmed');

  const confirmedData = syntheticObligationData({
    bills: [{
      id: 'conf-hydro',
      label: 'Confirmed hydro',
      frequency: 'once',
      date: '2026-08-26',
      amount: 90,
      confidence: 'confirmed',
    }],
  });
  const confirmedPacket = Assistant.buildPacket({
    data: confirmedData,
    periods: null,
    questionsMarkdown: '',
    now: '2026-08-24T12:00:00.000Z',
    env: {},
  });
  const confirmedAdvice = adviceFor(confirmedData, null);
  const confirmedSource = earliestNamedOutflow(
    confirmedAdvice.sim.events,
    confirmedData.plan.opening.asOf
  );
  ok(confirmedSource && confirmedSource.confidence === 'confirmed',
    'independent Forecast event for the confirmed fixture is confirmed');
  ok(confirmedPacket.current.nextSignificantObligations.nextDue.confidence === 'confirmed',
    'confirmed nextDue stays confirmed rather than being forced to estimated',
    confirmedPacket.current.nextSignificantObligations.nextDue.confidence);

  const boundaryData = syntheticObligationData({
    bills: [
      {
        id: 'est-boundary',
        label: 'Estimated boundary bill',
        frequency: 'once',
        date: '2026-08-29',
        amount: 110,
        confidence: 'estimated',
      },
      {
        id: 'conf-boundary',
        label: 'Confirmed boundary bill',
        frequency: 'once',
        date: '2026-08-29',
        amount: 55,
        confidence: 'confirmed',
      },
    ],
  });
  const boundaryPacket = Assistant.buildPacket({
    data: boundaryData,
    periods: null,
    questionsMarkdown: '',
    now: '2026-08-24T12:00:00.000Z',
    env: {},
  });
  const boundaryAdvice = adviceFor(boundaryData, null);
  const nb = boundaryPacket.current.nextSignificantObligations.nearBoundary;
  const estItem = (nb && nb.items || []).find(item => item.id === 'est-boundary');
  const confItem = (nb && nb.items || []).find(item => item.id === 'conf-boundary');
  const sourceEst = (boundaryAdvice.sim.events || []).find(event =>
    event.id === 'est-boundary' && event.date === '2026-08-29');
  ok(sourceEst && sourceEst.confidence === 'estimated',
    'independent Forecast near-boundary event is estimated');
  ok(estItem && estItem.confidence === 'estimated',
    'estimated near-boundary item remains estimated in the packet',
    estItem && estItem.confidence);
  ok(confItem && confItem.confidence === 'confirmed',
    'confirmed near-boundary item keeps confirmed',
    confItem && confItem.confidence);
  ok(nb && nb.confidence === 'estimated',
    'grouped near-boundary total uses the weaker estimated confidence',
    nb && nb.confidence);
  ok(nb.confidence !== 'confirmed',
    'grouped near-boundary total is not promoted to confirmed');
}

console.log('\n=== unavailable answers stay unavailable ===');
{
  const packet = Assistant.buildPacket({
    data: clone(liveData),
    periods: null,
    questionsMarkdown: '',
    now: '2026-08-24T12:00:00.000Z',
    env: {},
  });
  ok(packet.actuals.status === 'unavailable',
    'missing periods.json is actuals unavailable, not a replacement series',
    packet.actuals.reason);
}

console.log('\n=== live overlay fail-closed is preserved ===');
{
  const failed = LivePlan.failedOverlay(clone(liveData), 'provider-unavailable');
  const packet = Assistant.buildPacket({
    data: failed,
    periods: Assistant.loadPeriods(),
    questionsMarkdown: '',
    now: '2026-08-24T12:00:00.000Z',
    env: {},
  });
  ok(packet.metadata.freshness.liveOverlayApplied === false,
    'failed overlay is disclosed as not applied');
  ok(packet.uncertainty.liveOverlayFailed
    && packet.uncertainty.liveOverlayFailed.reason,
    'uncertainty records the sanitized overlay failure');
  ok(near(packet.current.spendableHouseholdCash.value,
    Forecast.startingCashAmount(liveData.plan)),
    'fail-closed packet keeps the dated opening cash');
  ok(packet.metadata.canonicalAsOf === liveData.plan.opening.asOf,
    'canonical as-of remains the dated opening');
}

console.log('\n=== HTTP fail-closed without assistant token ===');
  await withAtlas({}, async ({ base }) => {
    const res = await fetch(`${base}/assistant/current`, { redirect: 'manual' });
    ok(res.status === 503, 'unset ATLAS_ASSISTANT_TOKEN returns 503', `status ${res.status}`);
    const body = await res.json();
    ok(body.error === 'assistant unavailable', '503 body does not leak data');
    ok(!body.current && !body.forecast, '503 body has no financial packet');
    const authed = await login(base);
    const dataRes = await fetch(`${base}/data.json`, { headers: { cookie: authed.cookie } });
    ok(dataRes.status === 200, 'browser /data.json still works without assistant token');
    const assistantWithCookie = await fetch(`${base}/assistant/current`, {
      headers: { cookie: authed.cookie },
      redirect: 'manual',
    });
    ok(assistantWithCookie.status === 503,
      'browser session does not open the assistant surface when token is unset',
      `status ${assistantWithCookie.status}`);
  });
  filesUnchanged('no-token requests');

  console.log('\n=== HTTP dedicated Bearer auth ===');
  await withAtlas({ ATLAS_ASSISTANT_TOKEN: ASSISTANT_TOKEN }, async ({ base }) => {
    const none = await fetch(`${base}/assistant/current`, { redirect: 'manual' });
    ok(none.status === 401, 'missing Bearer fails closed', `status ${none.status}`);
    ok((none.headers.get('www-authenticate') || '').includes('Bearer'),
      '401 advertises Bearer for a later MCP adapter');

    const wrong = await fetch(`${base}/assistant/current`, {
      headers: { authorization: `Bearer ${WRONG_TOKEN}` },
      redirect: 'manual',
    });
    ok(wrong.status === 401, 'wrong Bearer fails closed', `status ${wrong.status}`);
    const wrongBody = await wrong.json();
    ok(!wrongBody.current && wrongBody.error === 'not authenticated',
      'wrong credentials do not return a packet');

    const query = await fetch(
      `${base}/assistant/current?token=${encodeURIComponent(ASSISTANT_TOKEN)}`,
      { redirect: 'manual' }
    );
    ok(query.status === 401, 'token in the query string is ignored', `status ${query.status}`);

    const siteAsBearer = await fetch(`${base}/assistant/current`, {
      headers: { authorization: `Bearer ${PASS}` },
      redirect: 'manual',
    });
    ok(siteAsBearer.status === 401,
      'SITE_PASSWORD is not assistant authentication',
      `status ${siteAsBearer.status}`);

    const authed = await login(base);
    ok(authed.status === 302 && authed.setCookie.includes('hfd_session='),
      'browser login still issues the session cookie');
    const cookieOnly = await fetch(`${base}/assistant/current`, {
      headers: { cookie: authed.cookie },
      redirect: 'manual',
    });
    ok(cookieOnly.status === 401,
      'browser session cookie does not unlock /assistant/current',
      `status ${cookieOnly.status}`);
    const dataRes = await fetch(`${base}/data.json`, { headers: { cookie: authed.cookie } });
    ok(dataRes.status === 200, 'existing browser /data.json auth is unchanged');
    const data = await dataRes.json();
    ok(data.plan && Array.isArray(data.debts), 'session still receives the browser data document');

    const assistantAsData = await fetch(`${base}/data.json`, {
      headers: { authorization: `Bearer ${ASSISTANT_TOKEN}` },
      redirect: 'manual',
    });
    ok(assistantAsData.status === 401,
      'assistant Bearer does not unlock browser /data.json',
      `status ${assistantAsData.status}`);

    const good = await fetch(`${base}/assistant/current`, {
      headers: { authorization: `Bearer ${ASSISTANT_TOKEN}` },
    });
    ok(good.status === 200, 'correct assistant token returns 200', `status ${good.status}`);
    const packet = await good.json();
    ok(packet.schema === Assistant.SCHEMA, 'authenticated response is the sanitized contract');
    ok(Assistant.looksSanitized(packet) && !forbiddenBlob(packet),
      'HTTP packet contains no secrets/provider ids/raw transactions');
    const periods = Assistant.loadPeriods();
    const served = await LivePlan.applyForServer(clone(liveData), isolatedEnv({}));
    const expected = Assistant.buildPacket({
      data: served,
      periods,
      questionsMarkdown: fs.readFileSync(QUESTIONS, 'utf8'),
      now: packet.metadata.generatedAt,
      env: isolatedEnv({ ATLAS_ASSISTANT_TOKEN: ASSISTANT_TOKEN }),
    });
    ok(near(packet.current.spendableHouseholdCash.value,
      expected.current.spendableHouseholdCash.value),
      'HTTP packet spendable matches the builder on the same served data');
    ok(near(packet.forecast.recommendation.weekly,
      expected.forecast.recommendation.weekly),
      'HTTP packet weekly matches Forecast via the builder');
    ok(!packet.metadata.generatedAt || typeof packet.metadata.generatedAt === 'string',
      'packet includes generatedAt');

    const posted = await fetch(`${base}/assistant/current`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ASSISTANT_TOKEN}` },
      redirect: 'manual',
    });
    ok(posted.status === 405, 'POST cannot write through the assistant route',
      `status ${posted.status}`);
    const put = await fetch(`${base}/assistant/current`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ASSISTANT_TOKEN}` },
      redirect: 'manual',
    });
    ok(put.status === 405, 'PUT is refused', `status ${put.status}`);
  });
  filesUnchanged('authenticated assistant GET');

  console.log('\n=== live observation failure stays fail-closed over HTTP ===');
  await withAtlas({
    ATLAS_ASSISTANT_TOKEN: ASSISTANT_TOKEN,
    ATLAS_LIVE_OVERLAY: 'live',
  }, async ({ base }) => {
    const good = await fetch(`${base}/assistant/current`, {
      headers: { authorization: `Bearer ${ASSISTANT_TOKEN}` },
    });
    ok(good.status === 200, 'live-mode request still returns a packet when observation fails');
    const packet = await good.json();
    ok(packet.metadata.freshness.liveOverlayApplied === false,
      'HTTP packet preserves overlay fail-closed');
    ok(packet.uncertainty.liveOverlayFailed,
      'HTTP packet surfaces overlay failure as uncertainty');
    ok(near(packet.current.spendableHouseholdCash.value,
      Forecast.startingCashAmount(liveData.plan)),
      'failed live observation does not invent a replacement cash figure');
    ok(!forbiddenBlob(packet), 'failed live packet remains sanitized');
  });
  filesUnchanged('failed live overlay via assistant');

  console.log('\n=== provider mock is GET-only and assistant does not write ===');
  {
    const calls = [];
    const mock = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        calls.push({ method: req.method, url: req.url });
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'unauthorized' }));
      });
      server.listen(0, '127.0.0.1', () => resolve({
        server,
        port: server.address().port,
        close: () => new Promise(done => server.close(() => done())),
      }));
      server.on('error', reject);
    });
    try {
      await withAtlas({
        ATLAS_ASSISTANT_TOKEN: ASSISTANT_TOKEN,
        ATLAS_LIVE_OVERLAY: 'live',
        [O.API_BASE_ENV]: `http://127.0.0.1:${mock.port}/v2`,
        LUNCHMONEY_ACCESS_TOKEN: 'synthetic-readonly-token-not-real',
      }, async ({ base }) => {
        const good = await fetch(`${base}/assistant/current`, {
          headers: { authorization: `Bearer ${ASSISTANT_TOKEN}` },
        });
        const packet = await good.json();
        ok(good.status === 200, 'unauthorized provider still fail-closes to a packet');
        ok(packet.metadata.freshness.liveOverlayApplied === false,
          'unauthorized provider does not apply a live overlay');
        ok(calls.every(c => c.method === 'GET' || c.method === 'HEAD'),
          'assistant request caused no provider POST/PUT/PATCH/DELETE',
          calls.map(c => c.method).join(',') || 'no calls');
      });
    } finally {
      await mock.close();
    }
    filesUnchanged('provider unauthorized through assistant');
  }

  console.log('\n=== weak assistant token refuses to start ===');
  {
    const result = await expectExit({ ATLAS_ASSISTANT_TOKEN: 'too-short' });
    ok(result.code !== 0, 'too-short ATLAS_ASSISTANT_TOKEN is fatal', `exit ${result.code}`);
    ok(/ATLAS_ASSISTANT_TOKEN/.test(result.stderr),
      'fatal message names the assistant token without printing it');
    ok(!/too-short/.test(result.stderr), 'the weak token value is not logged');
  }
  {
    const shared = 'shared-secret-must-not-be-reused-32!';
    const reusedPassword = await expectExit({
      SITE_PASSWORD: shared,
      ATLAS_ASSISTANT_TOKEN: shared,
    });
    ok(reusedPassword.code !== 0,
      'reusing SITE_PASSWORD as ATLAS_ASSISTANT_TOKEN is fatal',
      `exit ${reusedPassword.code}`);
    ok(/SITE_PASSWORD/.test(reusedPassword.stderr),
      'reuse-of-password fatal names SITE_PASSWORD');
    ok(!/shared-secret-must-not-be-reused/.test(reusedPassword.stderr),
      'the reused password value is not logged');
    const reusedSession = await expectExit({
      SESSION_SECRET: shared,
      ATLAS_ASSISTANT_TOKEN: shared,
    });
    ok(reusedSession.code !== 0,
      'reusing SESSION_SECRET as ATLAS_ASSISTANT_TOKEN is fatal',
      `exit ${reusedSession.code}`);
    ok(/SESSION_SECRET/.test(reusedSession.stderr),
      'reuse-of-session fatal names SESSION_SECRET');
  }

  console.log('\n=== MCP adapter is one OAuth-declared read-only transport ===');
  {
    const descriptor = AssistantMcp.toolDescriptor();
    ok(descriptor.name === AssistantMcp.TOOL_NAME,
      'the sole descriptor is get_atlas_current');
    ok(descriptor.annotations.readOnlyHint === true
        && descriptor.annotations.destructiveHint === false
        && descriptor.annotations.openWorldHint === false,
      'tool annotations declare the closed read-only boundary');
    ok(descriptor._meta.securitySchemes.length === 1
        && descriptor._meta.securitySchemes[0].type === 'oauth2'
        && descriptor._meta.securitySchemes[0].scopes.length === 1
        && descriptor._meta.securitySchemes[0].scopes[0] === AssistantMcp.REQUIRED_SCOPE,
      'tool metadata declares only atlas.current.read OAuth');
    const packet = Assistant.buildPacket({
      data: clone(liveData),
      periods: Assistant.loadPeriods(),
      questionsMarkdown: '',
      now: '2026-08-24T12:00:00.000Z',
      env: {},
    });
    const result = AssistantMcp.packetResult(packet);
    ok(result.isError === false && result.structuredContent === packet,
      'tool result is the incumbent packet object');
    ok(!forbiddenBlob(result), 'tool result remains sanitized');
    const mcpSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'assistant-mcp.js'), 'utf8');
    ok(!/Forecast\.recommend/.test(mcpSrc) && !/startingCashAmount/.test(mcpSrc),
      'MCP transport does not call Forecast or recompute cash');
    ok(/assistant-packet/.test(mcpSrc) && /looksSanitized/.test(mcpSrc),
      'MCP transport consumes the incumbent packet sanitizer');
    ok(/scopeDenial/.test(mcpSrc)
        && mcpSrc.indexOf('scopeDenial') < mcpSrc.indexOf('.invoke('),
      'MCP transport enforces Lunch Money operation scopes before dispatch');
  }

  console.log('\n=== OAuth MCP fails closed when configuration is absent ===');
  {
    const partial = AssistantOAuth.readConfig({
      ATLAS_MCP_RESOURCE_URL: 'https://atlas.example/assistant/mcp',
    });
    ok(partial.configured === false && partial.reason === 'oauth-configuration-incomplete',
      'partial OAuth configuration fails closed');
    const insecure = AssistantOAuth.readConfig({
      ATLAS_MCP_RESOURCE_URL: 'https://atlas.example/assistant/mcp',
      ATLAS_OAUTH_ISSUER: 'http://issuer.example/',
      ATLAS_OAUTH_JWKS_URI: 'https://issuer.example/jwks',
    });
    ok(insecure.configured === false && /HTTPS/.test(insecure.reason),
      'non-local HTTP issuer fails closed');

    const issuerNoSlash = 'https://auth.example/realms/atlas';
    const exactIssuer = AssistantOAuth.readConfig({
      ATLAS_MCP_RESOURCE_URL: 'https://atlas.example/assistant/mcp',
      ATLAS_OAUTH_ISSUER: issuerNoSlash,
      ATLAS_OAUTH_JWKS_URI: 'https://auth.example/realms/atlas/jwks',
    });
    ok(exactIssuer.configured === true && exactIssuer.issuer === issuerNoSlash,
      'configured issuer without a trailing slash is stored exactly');
    ok(AssistantOAuth.protectedResourceMetadata(exactIssuer).authorization_servers[0]
        === issuerNoSlash,
      'protected-resource metadata advertises the exact configured issuer');

    const originIssuer = 'https://auth.example';
    const originConfig = AssistantOAuth.readConfig({
      ATLAS_MCP_RESOURCE_URL: 'https://atlas.example/assistant/mcp',
      ATLAS_OAUTH_ISSUER: originIssuer,
      ATLAS_OAUTH_JWKS_URI: 'https://auth.example/jwks',
    });
    ok(originConfig.configured === true
        && originConfig.issuer === originIssuer
        && new URL(originIssuer).href === originIssuer + '/'
        && AssistantOAuth.protectedResourceMetadata(originConfig).authorization_servers[0]
          === originIssuer,
      'origin-only issuer without a trailing slash is preserved exactly');
  }

  console.log('\n=== JWT verifier uses the exact issuer and rejects opaque tokens ===');
  {
    const jose = await import('jose');
    const pair = await jose.generateKeyPair('RS256', { extractable: true });
    const issuer = 'https://auth.example';
    const resource = 'https://atlas.example/assistant/mcp';
    const config = AssistantOAuth.readConfig({
      ATLAS_MCP_RESOURCE_URL: resource,
      ATLAS_OAUTH_ISSUER: issuer,
      ATLAS_OAUTH_JWKS_URI: 'https://auth.example/jwks',
    });
    const verifier = AssistantOAuth.createTokenVerifier(config, {
      jose,
      jwks: pair.publicKey,
    });
    const now = Math.floor(Date.now() / 1000);
    async function sign(iss) {
      return new jose.SignJWT({
        scope: AssistantMcp.REQUIRED_SCOPE,
        client_id: 'atlas-jwt-proof',
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(iss)
        .setAudience(resource)
        .setIssuedAt(now)
        .setNotBefore(now - 1)
        .setExpirationTime(now + 300)
        .sign(pair.privateKey);
    }
    const exact = await verifier.verifyAccessToken(await sign(issuer));
    ok(exact.scopes.includes(AssistantMcp.REQUIRED_SCOPE),
      'JWT with the exact configured issuer verifies');
    let slashRejected = false;
    try {
      await verifier.verifyAccessToken(await sign(`${issuer}/`));
    } catch {
      slashRejected = true;
    }
    ok(slashRejected, 'slash-mutated issuer identifier fails closed');
    let opaqueRejected = false;
    try {
      await verifier.verifyAccessToken('opaque-access-token-not-a-jwt');
    } catch {
      opaqueRejected = true;
    }
    ok(opaqueRejected, 'opaque non-JWT access tokens fail closed');
  }
  await withAtlas({ ATLAS_ASSISTANT_TOKEN: ASSISTANT_TOKEN }, async ({ base }) => {
    const metadata = await fetch(`${base}${AssistantOAuth.METADATA_PATH}`);
    ok(metadata.status === 503, 'missing OAuth configuration withholds protected-resource metadata');
    const res = await fetch(`${base}/assistant/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      redirect: 'manual',
    });
    ok(res.status === 503, 'missing OAuth configuration withholds MCP', `status ${res.status}`);
    const body = await res.json();
    ok(body.error === 'assistant oauth unavailable' && !body.result,
      'unconfigured MCP response contains no packet');
  });

  console.log('\n=== standards-compatible OAuth protects the one MCP tool ===');
  await withOAuthAtlas(async ({ base, resource, oauth, lunchMoney }) => {
    async function mcp(headers, body) {
      return fetch(resource, {
        method: 'POST',
        headers: Object.assign({
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        }, headers || {}),
        body: JSON.stringify(body),
        redirect: 'manual',
      });
    }
    const initialize = {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'atlas-oauth-test', version: '1' },
      },
    };
    const metadataRes = await fetch(`${base}${AssistantOAuth.METADATA_PATH}`);
    const metadata = await metadataRes.json();
    ok(metadataRes.status === 200
        && metadata.resource === resource
        && metadata.authorization_servers.length === 1
        && metadata.authorization_servers[0] === oauth.issuer,
      'protected-resource metadata binds the MCP resource to one external issuer');
    ok(metadata.scopes_supported.length === 3
        && metadata.scopes_supported[0] === AssistantMcp.REQUIRED_SCOPE
        && metadata.scopes_supported.includes(LunchMoney.READ_SCOPE)
        && metadata.scopes_supported.includes(LunchMoney.WRITE_SCOPE),
      'protected-resource metadata advertises packet read plus distinct ledger read/write scopes');

    const none = await mcp({}, initialize);
    const challenge = none.headers.get('www-authenticate') || '';
    ok(none.status === 401, 'unauthenticated MCP access is denied', `status ${none.status}`);
    const expectedChallengeScope = AssistantOAuth.CHALLENGE_SCOPES.join(' ');
    ok(challenge.includes(`resource_metadata=\"${base}${AssistantOAuth.METADATA_PATH}\"`)
        && challenge.includes(`scope=\"${expectedChallengeScope}\"`)
        && !challenge.includes(LunchMoney.WRITE_SCOPE),
      '401 challenge advertises metadata and packet+ledger-read scope without write');

    const malformed = await mcp({ authorization: 'Basic invalid' }, initialize);
    ok(malformed.status === 401, 'malformed authorization fails closed', `status ${malformed.status}`);
    const opaque = await mcp({ authorization: `Bearer ${ASSISTANT_TOKEN}` }, initialize);
    ok(opaque.status === 401,
      'the incumbent static assistant token cannot authenticate MCP', `status ${opaque.status}`);

    const now = Math.floor(Date.now() / 1000);
    const expiredToken = await oauth.sign(resource, { expiresAt: now - 30 });
    const expired = await mcp({ authorization: `Bearer ${expiredToken}` }, initialize);
    ok(expired.status === 401, 'expired OAuth access token fails closed', `status ${expired.status}`);
    const futureToken = await oauth.sign(resource, { notBefore: now + 300 });
    const future = await mcp({ authorization: `Bearer ${futureToken}` }, initialize);
    ok(future.status === 401, 'not-yet-valid OAuth access token fails closed', `status ${future.status}`);
    const wrongAudienceToken = await oauth.sign(resource, { audience: `${base}/not-atlas` });
    const wrongAudience = await mcp({ authorization: `Bearer ${wrongAudienceToken}` }, initialize);
    ok(wrongAudience.status === 401, 'wrong-resource token fails closed', `status ${wrongAudience.status}`);
    const wrongSignatureToken = await oauth.sign(resource, { key: oauth.otherPrivateKey });
    const wrongSignature = await mcp({ authorization: `Bearer ${wrongSignatureToken}` }, initialize);
    ok(wrongSignature.status === 401, 'invalid signature fails closed', `status ${wrongSignature.status}`);
    const wrongIssuerToken = await oauth.sign(resource, { issuer: 'https://evil.example/' });
    const wrongIssuer = await mcp({ authorization: `Bearer ${wrongIssuerToken}` }, initialize);
    ok(wrongIssuer.status === 401, 'wrong-issuer token fails closed', `status ${wrongIssuer.status}`);
    const noScopeToken = await oauth.sign(resource, { scope: 'profile' });
    const noScope = await mcp({ authorization: `Bearer ${noScopeToken}` }, initialize);
    const noScopeChallenge = noScope.headers.get('www-authenticate') || '';
    ok(noScope.status === 403, 'missing atlas.current.read scope fails closed', `status ${noScope.status}`);
    ok(noScopeChallenge.includes(`scope=\"${expectedChallengeScope}\"`)
        && !noScopeChallenge.includes(LunchMoney.WRITE_SCOPE),
      '403 insufficient_scope challenge advertises packet+ledger-read without write');

    const browser = await login(base);
    const cookieOnly = await mcp({ cookie: browser.cookie }, initialize);
    ok(cookieOnly.status === 401, 'browser session cookie does not unlock MCP',
      `status ${cookieOnly.status}`);
    const browserData = await fetch(`${base}/data.json`, { headers: { cookie: browser.cookie } });
    ok(browserData.status === 200, 'browser login still unlocks only the browser data route');

    const accessToken = await oauth.sign(resource);
    const oauthOnCurrent = await fetch(`${base}/assistant/current`, {
      headers: { authorization: `Bearer ${accessToken}` }, redirect: 'manual',
    });
    ok(oauthOnCurrent.status === 401,
      'OAuth MCP token does not replace the incumbent /assistant/current token');
    const directRes = await fetch(`${base}/assistant/current`, {
      headers: { authorization: `Bearer ${ASSISTANT_TOKEN}` },
    });
    const direct = await directRes.json();
    ok(directRes.status === 200 && direct.schema === Assistant.SCHEMA,
      'incumbent /assistant/current remains independently authenticated');

    const client = new Client({ name: 'atlas-oauth-proof', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      ok(listed.tools.length === 7 && listed.tools[0].name === AssistantMcp.TOOL_NAME
        && listed.tools.some(tool => tool.name === 'apply_lunchmoney_edit'),
        'official MCP client sees current state plus Lunch Money lookup/preview/edit tools');
      const listedTool = listed.tools[0];
      ok(listedTool.annotations.readOnlyHint === true
          && listedTool.annotations.destructiveHint === false
          && listedTool._meta.securitySchemes[0].scopes[0] === AssistantMcp.REQUIRED_SCOPE,
        'official MCP client receives read-only and OAuth tool metadata');
      const called = await client.callTool({ name: AssistantMcp.TOOL_NAME, arguments: {} });
      const wrapped = called.structuredContent;
      ok(called.isError === false && wrapped.schema === Assistant.SCHEMA,
        'authorized official MCP client invokes the incumbent current-state tool');
      ok(Assistant.looksSanitized(wrapped) && !forbiddenBlob(called)
          && !JSON.stringify(called).includes(accessToken),
        'MCP response contains no secrets, access token, provider ids, or raw transactions');
      ok(near(wrapped.current.spendableHouseholdCash.value,
        direct.current.spendableHouseholdCash.value),
      'MCP spendable matches incumbent /assistant/current');
      ok(near(wrapped.forecast.recommendation.weekly,
        direct.forecast.recommendation.weekly),
      'MCP weekly answer matches incumbent Forecast-backed packet');
      ok(wrapped.authority.planner === 'Forecast'
          && wrapped.writesCanonicalState === false
          && wrapped.productionWrite === false,
        'MCP packet preserves Forecast authority and declares no writes');
      lunchMoney.resetHits();
      const deniedCatalog = await client.callTool({ name: 'get_lunchmoney_catalog', arguments: {} });
      ok(deniedCatalog.isError === true
          && deniedCatalog.structuredContent.reason === 'transaction-read-scope-required',
        'packet-only OAuth token cannot read the Lunch Money catalog');
      const deniedQuery = await client.callTool({
        name: 'get_lunchmoney_transactions',
        arguments: { startDate: '2026-10-01', endDate: '2026-10-02' },
      });
      ok(deniedQuery.isError === true
          && deniedQuery.structuredContent.reason === 'transaction-read-scope-required',
        'packet-only OAuth token cannot read Lunch Money transactions');
      const deniedPrepare = await httpRefusal(client.callTool({
        name: 'prepare_lunchmoney_edit',
        arguments: { transactionRef: 'tx-' + 'a'.repeat(24), changes: { notes: 'no' } },
      }));
      ok(deniedPrepare && deniedPrepare.code === 403,
        'packet-only OAuth token cannot prepare Lunch Money edits (HTTP 403 step-up)');
      const deniedEdit = await httpRefusal(client.callTool({ name: 'apply_lunchmoney_edit',
        arguments: { previewId: 'edit-' + 'a'.repeat(48), confirmed: true } }));
      ok(deniedEdit && deniedEdit.code === 403,
        'packet-only OAuth token cannot apply Lunch Money edits (HTTP 403 step-up)');
      ok(lunchMoney.hits() === 0,
        'packet-only Lunch Money denials never reach the provider');
      const catalogTool = listed.tools.find(tool => tool.name === 'get_lunchmoney_catalog');
      const queryTool = listed.tools.find(tool => tool.name === 'get_lunchmoney_transactions');
      ok(catalogTool._meta.securitySchemes[0].scopes.includes(LunchMoney.READ_SCOPE)
          && queryTool._meta.securitySchemes[0].scopes.includes(LunchMoney.READ_SCOPE)
          && !catalogTool._meta.securitySchemes[0].scopes.includes(LunchMoney.WRITE_SCOPE),
        'lookup tools advertise the distinct ledger-read scope');
      const writeTool = listed.tools.find(tool => tool.name === 'apply_lunchmoney_edit');
      ok(writeTool.annotations.readOnlyHint === false && writeTool.annotations.idempotentHint === false
        && writeTool._meta.securitySchemes[0].scopes.includes(LunchMoney.WRITE_SCOPE),
        'write tool advertises distinct write scope and non-idempotent semantics');
      let refused = false;
      try {
        const writeAttempt = await client.callTool({
          name: 'canonical-refresh', arguments: { apply: true },
        });
        refused = writeAttempt.isError === true;
      } catch {
        refused = true;
      }
      ok(refused, 'a write-shaped MCP tool name does not exist');
    } finally {
      await client.close().catch(() => {});
    }

    const permissionsOnlyWiden = await oauth.sign(resource, {
      scope: AssistantMcp.REQUIRED_SCOPE,
      permissions: [LunchMoney.READ_SCOPE, LunchMoney.WRITE_SCOPE],
    });
    await withOfficialMcp(resource, permissionsOnlyWiden, async widenClient => {
      lunchMoney.resetHits();
      const deniedWiden = await widenClient.callTool({
        name: 'get_lunchmoney_catalog', arguments: {},
      });
      ok(deniedWiden.isError === true
          && deniedWiden.structuredContent.reason === 'transaction-read-scope-required',
        'permissions claim alone does not widen ledger access beyond JWT scope');
      ok(lunchMoney.hits() === 0,
        'permissions-only widening denial never reaches the provider');
      const deniedWriteWiden = await httpRefusal(widenClient.callTool({
        name: 'prepare_lunchmoney_edit',
        arguments: { transactionRef: 'tx-' + 'c'.repeat(24), changes: { notes: 'no' } },
      }));
      ok(deniedWriteWiden && deniedWriteWiden.code === 403,
        'read-scope-absent token cannot prepare writes even when permissions list write');
      ok(lunchMoney.hits() === 0,
        'permissions-only write denial never reaches the provider');
    });

    const readToken = await oauth.sign(resource, {
      scope: `${AssistantMcp.REQUIRED_SCOPE} ${LunchMoney.READ_SCOPE}`,
    });
    await withOfficialMcp(resource, readToken, async readClient => {
      lunchMoney.resetHits();
      const catalog = await readClient.callTool({ name: 'get_lunchmoney_catalog', arguments: {} });
      ok(catalog.isError === false && catalog.structuredContent.status === 'ok'
          && catalog.structuredContent.categories.length === 2,
        'ledger-read OAuth token can read the Lunch Money catalog');
      const balances = catalog.structuredContent.accounts;
      ok(balances.length === 3
          && balances[0].balance.amount === '-50.2500'
          && balances[1].name === 'EMERGENCY SAVING'
          && balances[1].subtype === 'savings'
          && balances[1].balance.amount === '1234.5678'
          && balances[1].balance.asOf === '2026-10-01T18:00:00Z'
          && balances[1].timestamps.lastFetchedAt === '2026-10-02T18:00:00Z'
          && balances[2].balance.amount === '800.0000'
          && balances[2].balance.currency === 'usd'
          && balances[2].balance.asOf === '2026-08-18'
          && balances.every(row => row.balance.trust === 'unknown'),
        'authenticated MCP round trip preserves savings, exact balances, currencies and actual balance dates');
      ok(lunchMoney.hits() === 3 && catalog.structuredContent.providerWrite === false
          && catalog.structuredContent.writesAtlasState === false,
        'balance catalog uses only the three incumbent provider GETs without state writes');
      const queried = await readClient.callTool({
        name: 'get_lunchmoney_transactions',
        arguments: { startDate: '2026-10-01', endDate: '2026-10-02' },
      });
      ok(queried.isError === false && queried.structuredContent.matchedCount === 1
          && queried.structuredContent.rows[0].payee === 'Synthetic Shop'
          && queried.structuredContent.rows[0].amount === '19.9900',
        'ledger-read OAuth token preserves provider transaction amount precision');
      ok(lunchMoney.hits() > 0, 'authorized ledger reads reach the provider stub');
      lunchMoney.failTransactions(true);
      const failedQuery = await readClient.callTool({
        name: 'get_lunchmoney_transactions',
        arguments: { startDate: '2026-10-01', endDate: '2026-10-02' },
      });
      lunchMoney.failTransactions(false);
      ok(failedQuery.isError === true
          && failedQuery.structuredContent.reason === 'lunchmoney-operation-unavailable'
          && failedQuery.structuredContent.diagnostic.stage === 'transactions-request'
          && failedQuery.structuredContent.diagnostic.code === 'provider-request-failed'
          && failedQuery.structuredContent.diagnostic.upstreamStatus === 429
          && !JSON.stringify(failedQuery).includes('synthetic-private-ledger-and-token'),
        'authenticated MCP failures preserve safe stage/code/status without provider body');
      lunchMoney.resetHits();
      const deniedWrite = await httpRefusal(readClient.callTool({
        name: 'prepare_lunchmoney_edit',
        arguments: {
          transactionRef: queried.structuredContent.rows[0].transactionRef,
          changes: { notes: 'no' },
        },
      }));
      ok(deniedWrite && deniedWrite.code === 403,
        'ledger-read OAuth token cannot prepare Lunch Money edits (HTTP 403 step-up)');
      const deniedApply = await httpRefusal(readClient.callTool({ name: 'apply_lunchmoney_edit',
        arguments: { previewId: 'edit-' + 'b'.repeat(48), confirmed: true } }));
      ok(deniedApply && deniedApply.code === 403,
        'ledger-read OAuth token cannot apply Lunch Money edits (HTTP 403 step-up)');
      ok(lunchMoney.hits() === 0, 'ledger-read write denials never reach the provider');
      const stillReads = await readClient.callTool({ name: 'get_lunchmoney_catalog', arguments: {} });
      ok(stillReads.isError === false && stillReads.structuredContent.status === 'ok',
        'ledger-read token still reads after a write step-up refusal');

    });

    const writeToken = await oauth.sign(resource, {
      scope: `${AssistantMcp.REQUIRED_SCOPE} ${LunchMoney.READ_SCOPE} ${LunchMoney.WRITE_SCOPE}`,
    });
    await withOfficialMcp(resource, writeToken, async writeClient => {
      const catalog = await writeClient.callTool({ name: 'get_lunchmoney_catalog', arguments: {} });
      const queried = await writeClient.callTool({
        name: 'get_lunchmoney_transactions',
        arguments: { startDate: '2026-10-01', endDate: '2026-10-02' },
      });
      const preview = await writeClient.callTool({
        name: 'prepare_lunchmoney_edit',
        arguments: {
          transactionRef: queried.structuredContent.rows[0].transactionRef,
          changes: {
            categoryRef: catalog.structuredContent.categories[1].categoryRef,
            notes: 'Owner confirmed correction',
          },
        },
      });
      ok(preview.isError === false && preview.structuredContent.status === 'preview'
          && preview.structuredContent.providerWrite === false,
        'write-scoped OAuth token can prepare an exact Lunch Money edit');
      const applied = await writeClient.callTool({
        name: 'apply_lunchmoney_edit',
        arguments: { previewId: preview.structuredContent.previewId, confirmed: true },
      });
      ok(applied.isError === false && applied.structuredContent.status === 'applied'
          && applied.structuredContent.verifiedByReadback === true
          && applied.structuredContent.transaction.amount === '19.9900',
        'write-scoped OAuth token can apply a confirmed Lunch Money edit');
    });

    console.log('\n  -- operation-specific write step-up: HTTP 403 insufficient_scope --');
    const stepUpScope = [AssistantMcp.REQUIRED_SCOPE, LunchMoney.READ_SCOPE, LunchMoney.WRITE_SCOPE].join(' ');
    const readScope = `${AssistantMcp.REQUIRED_SCOPE} ${LunchMoney.READ_SCOPE}`;
    const expectedStepUp = `Bearer error="insufficient_scope", scope="${stepUpScope}", `
      + `resource_metadata="${base}${AssistantOAuth.METADATA_PATH}"`;
    ok(AssistantOAuth.WRITE_STEP_UP_SCOPES.join(' ') === stepUpScope
        && AssistantOAuth.CHALLENGE_SCOPES.join(' ') === readScope,
      'write step-up names all three scopes; base challenge stays packet+ledger-read');
    const bearer = token => ({ authorization: `Bearer ${token}` });
    const toolCall = (id, name, args) => ({
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args || {} },
    });
    const prepareArgs = { transactionRef: 'tx-' + 'd'.repeat(24), changes: { notes: 'no' } };
    const applyArgs = { previewId: 'edit-' + 'd'.repeat(48), confirmed: true };
    async function expectStepUp(res, label) {
      const body = await res.json().catch(() => null);
      ok(res.status === 403
          && res.headers.get('www-authenticate') === expectedStepUp
          && body && body.error === 'insufficient_scope',
        label, `status ${res.status} challenge ${res.headers.get('www-authenticate')}`);
    }
    lunchMoney.resetHits();
    const writesBeforeStepUp = lunchMoney.writes();
    await expectStepUp(await mcp(bearer(readToken), toolCall(11, 'prepare_lunchmoney_edit', prepareArgs)),
      'read-only token calling prepare gets HTTP 403 with the exact write step-up challenge');
    await expectStepUp(await mcp(bearer(readToken), toolCall(12, 'apply_lunchmoney_edit', applyArgs)),
      'read-only token calling apply gets HTTP 403 with the exact write step-up challenge');
    await expectStepUp(await mcp(bearer(accessToken), toolCall(13, 'prepare_lunchmoney_edit', prepareArgs)),
      'packet-only token calling a write tool gets the same write step-up challenge');
    await expectStepUp(await mcp(bearer(permissionsOnlyWiden), toolCall(14, 'apply_lunchmoney_edit', applyArgs)),
      'permissions-claim-only write does not pass the write step-up');
    const permissionsWriteToken = await oauth.sign(resource, {
      scope: readScope,
      permissions: [AssistantMcp.REQUIRED_SCOPE, LunchMoney.READ_SCOPE, LunchMoney.WRITE_SCOPE],
    });
    await expectStepUp(await mcp(bearer(permissionsWriteToken), toolCall(15, 'prepare_lunchmoney_edit', prepareArgs)),
      'ledger-read token with write only in permissions still gets the write step-up');
    await expectStepUp(await mcp(bearer(readToken), [
      toolCall(16, 'get_lunchmoney_catalog'),
      toolCall(17, 'prepare_lunchmoney_edit', prepareArgs),
    ]), 'a batch containing a write tool call fails closed with the write step-up');
    await expectStepUp(await mcp(bearer(readToken), [null, 5, 'x', [], {},
      toolCall(18, 'apply_lunchmoney_edit', applyArgs)]),
    'junk batch members do not hide a write tool call');
    const notification = { jsonrpc: '2.0', method: 'tools/call',
      params: { name: 'apply_lunchmoney_edit', arguments: applyArgs } };
    await expectStepUp(await mcp(bearer(readToken), notification),
      'a write tool call without an id is still stepped up');

    for (const [label, body] of [
      ['params null', { jsonrpc: '2.0', id: 21, method: 'tools/call', params: null }],
      ['params array', { jsonrpc: '2.0', id: 22, method: 'tools/call', params: ['apply_lunchmoney_edit'] }],
      ['name array', { jsonrpc: '2.0', id: 23, method: 'tools/call',
        params: { name: ['apply_lunchmoney_edit'], arguments: applyArgs } }],
      ['missing name in batch', [toolCall(24, 'get_lunchmoney_catalog'),
        { jsonrpc: '2.0', id: 25, method: 'tools/call', params: { arguments: applyArgs } }]],
    ]) {
      for (const [who, token] of [['read-only', readToken], ['write', writeToken]]) {
        const res = await mcp(bearer(token), body);
        const parsed = await res.json().catch(() => null);
        ok(res.status === 400 && parsed && parsed.error && parsed.error.code === -32600,
          `unclassifiable tools/call (${label}, ${who} token) fails closed with 400`, `status ${res.status}`);
      }
    }
    const brokenJson = await fetch(resource, {
      method: 'POST',
      headers: Object.assign({ accept: 'application/json, text/event-stream',
        'content-type': 'application/json' }, bearer(readToken)),
      body: '{"jsonrpc":"2.0","id":31,"method":"tools/call","params":{"name":"apply_lunchmoney_edit"',
    });
    ok(brokenJson.status === 400, 'malformed JSON naming a write tool fails closed with 400',
      `status ${brokenJson.status}`);
    const writeShaped = [AssistantMcp.REQUIRED_SCOPE, LunchMoney.READ_SCOPE, LunchMoney.WRITE_SCOPE].join(' ');
    for (const [label, overrides] of [
      ['wrong signing key', { scope: writeShaped, key: oauth.otherPrivateKey }],
      ['expired', { scope: writeShaped, expiresAt: Math.floor(Date.now() / 1000) - 30 }],
      ['wrong audience', { scope: writeShaped, audience: `${base}/not-atlas` }],
      ['wrong issuer', { scope: writeShaped, issuer: 'https://evil.example/' }],
    ]) {
      const forged = await oauth.sign(resource, overrides);
      const res = await mcp(bearer(forged), toolCall(32, 'apply_lunchmoney_edit', applyArgs));
      ok(res.status === 401, `unverifiable write-scoped token (${label}) is refused with 401`, `status ${res.status}`);
    }
    ok(lunchMoney.hits() === 0 && lunchMoney.writes() === writesBeforeStepUp,
      'no step-up denial, malformed body or unverifiable token reaches the provider or writes');

    const readInit = await mcp(bearer(readToken), initialize);
    ok(readInit.status === 200 && !readInit.headers.get('www-authenticate'),
      'read-only token initialize is unchanged (200, no challenge)');
    const readList = await mcp(bearer(readToken), { jsonrpc: '2.0', id: 41, method: 'tools/list' });
    const readListBody = await readList.json();
    ok(readList.status === 200 && readListBody.result.tools.length === 7,
      'read-only token tools/list is unchanged and still lists the write tools');
    const readCatalogRaw = await mcp(bearer(readToken), toolCall(42, 'get_lunchmoney_catalog'));
    const readCatalogBody = await readCatalogRaw.json();
    ok(readCatalogRaw.status === 200 && readCatalogBody.result.isError === false
        && readCatalogBody.result.structuredContent.status === 'ok',
      'read-only token calling a read tool still gets 200');
    const packetCatalogRaw = await mcp(bearer(accessToken), toolCall(43, 'get_lunchmoney_catalog'));
    const packetCatalogBody = await packetCatalogRaw.json();
    ok(packetCatalogRaw.status === 200 && packetCatalogBody.result.isError === true
        && packetCatalogBody.result.structuredContent.reason === 'transaction-read-scope-required',
      'packet-only read-tool denial is unchanged (tool-level read-scope error, no 403)');
    const packetCurrentRaw = await mcp(bearer(accessToken), toolCall(44, AssistantMcp.TOOL_NAME));
    ok(packetCurrentRaw.status === 200, 'packet-only get_atlas_current is unchanged');
    const writeRaw = await mcp(bearer(writeToken), toolCall(45, 'prepare_lunchmoney_edit', prepareArgs));
    const writeRawBody = await writeRaw.json();
    ok(writeRaw.status === 200 && !writeRaw.headers.get('www-authenticate')
        && writeRawBody.result
        && writeRawBody.result.structuredContent.reason !== 'transaction-write-scope-required',
      'write-scoped token passes the step-up and reaches prepare');

    console.log('\n  -- official SDK client: 403 step-up re-authorizes once, then succeeds --');
    function stepUpProvider(initialTokens) {
      const state = { tokens: initialTokens, redirects: [], verifier: null, posts: 0 };
      const redirectUrl = 'http://127.0.0.1/atlas-step-up-callback';
      state.provider = {
        get redirectUrl() { return redirectUrl; },
        get clientMetadata() {
          return { client_name: 'atlas-step-up-proof', redirect_uris: [redirectUrl],
            grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
            token_endpoint_auth_method: 'none' };
        },
        clientInformation: () => ({ client_id: 'atlas-step-up-client' }),
        tokens: () => state.tokens,
        saveTokens: tokens => { state.tokens = tokens; },
        redirectToAuthorization: url => { state.redirects.push(new URL(String(url))); },
        saveCodeVerifier: verifier => { state.verifier = verifier; },
        codeVerifier: () => state.verifier,
      };
      return state;
    }
    async function withStepUpClient(state, fn) {
      const client = new Client({ name: 'atlas-step-up-proof', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(resource), {
        authProvider: state.provider,
        // Count every POST the SDK makes to Atlas, to prove retries are bounded.
        fetch: (url, init) => {
          if (String(url) === resource && init && init.method === 'POST') state.posts += 1;
          return fetch(url, init);
        },
      });
      try {
        await client.connect(transport);
        return await fn(client, transport);
      } finally {
        await client.close().catch(() => {});
      }
    }
    const granted = stepUpProvider(await oauth.issueTokens(readScope, resource));
    await withStepUpClient(granted, async (client, transport) => {
      const catalog = await client.callTool({ name: 'get_lunchmoney_catalog', arguments: {} });
      const queried = await client.callTool({
        name: 'get_lunchmoney_transactions',
        arguments: { startDate: '2026-10-01', endDate: '2026-10-02' },
      });
      ok(catalog.isError === false && queried.isError === false && granted.redirects.length === 0,
        'SDK client with a read-only grant reads without any re-authorization');
      const editArgs = {
        transactionRef: queried.structuredContent.rows[0].transactionRef,
        changes: { categoryRef: catalog.structuredContent.categories[0].categoryRef,
          notes: 'Synthetic step-up proof' },
      };
      lunchMoney.resetHits();
      const writesBefore = lunchMoney.writes();
      const postsBefore = granted.posts;
      const firstTry = await httpRefusal(client.callTool({ name: 'prepare_lunchmoney_edit', arguments: editArgs }));
      ok(firstTry instanceof UnauthorizedError && granted.redirects.length === 1
          && granted.posts - postsBefore === 1,
        'SDK client answers the write 403 with exactly one re-authorization and no blind retry',
        firstTry && `${firstTry.message}; posts ${granted.posts - postsBefore}`);
      const authUrl = granted.redirects[0];
      ok(authUrl && authUrl.searchParams.get('scope') === stepUpScope
          && authUrl.searchParams.get('resource') === resource
          && authUrl.searchParams.get('code_challenge_method') === 'S256',
        'step-up authorization requests the challenge scope (incl. write) for the exact resource with PKCE',
        authUrl && authUrl.search);
      ok(lunchMoney.hits() === 0, 'the refused write never reached the provider');
      await transport.finishAuth(oauth.issueCode(authUrl.searchParams.get('scope'), resource));
      ok(granted.tokens.scope === stepUpScope, 'consented step-up grant carries write');
      const preview = await client.callTool({ name: 'prepare_lunchmoney_edit', arguments: editArgs });
      ok(preview.isError === false && preview.structuredContent.status === 'preview'
          && preview.structuredContent.providerWrite === false
          && lunchMoney.writes() === writesBefore,
        'after step-up, the retried prepare returns a preview without writing');
      const unconfirmed = await client.callTool({ name: 'apply_lunchmoney_edit',
        arguments: { previewId: preview.structuredContent.previewId, confirmed: false } }).catch(err => err);
      ok((unconfirmed instanceof Error || unconfirmed.isError === true)
          && !(unconfirmed.structuredContent && unconfirmed.structuredContent.status === 'applied'),
        'apply still refuses without confirmed=true after step-up');
      const applied = await client.callTool({ name: 'apply_lunchmoney_edit',
        arguments: { previewId: preview.structuredContent.previewId, confirmed: true } });
      ok(applied.isError === false && applied.structuredContent.status === 'applied'
          && applied.structuredContent.verifiedByReadback === true
          && lunchMoney.writes() === writesBefore + 1,
        'after step-up, one confirmed apply makes exactly one provider write and verifies by readback');
      const replay = await client.callTool({ name: 'apply_lunchmoney_edit',
        arguments: { previewId: preview.structuredContent.previewId, confirmed: true } }).catch(err => err);
      ok((replay instanceof Error || replay.isError === true) && lunchMoney.writes() === writesBefore + 1,
        'replaying a consumed preview is refused and writes nothing');
      ok(granted.redirects.length === 1, 'no further re-authorization once write is granted');
    });

    const notAssigned = stepUpProvider(await oauth.issueTokens(readScope, resource));
    await withStepUpClient(notAssigned, async (client, transport) => {
      lunchMoney.resetHits();
      const firstTry = await httpRefusal(client.callTool({ name: 'prepare_lunchmoney_edit', arguments: prepareArgs }));
      ok(firstTry instanceof UnauthorizedError && notAssigned.redirects.length === 1,
        'issuer-withheld write: first refusal triggers one re-authorization');
      await transport.finishAuth(oauth.issueCode(notAssigned.redirects[0].searchParams.get('scope'), resource,
        { assigned: [AssistantMcp.REQUIRED_SCOPE, LunchMoney.READ_SCOPE] }));
      const secondTry = await httpRefusal(client.callTool({ name: 'prepare_lunchmoney_edit', arguments: prepareArgs }));
      ok(secondTry && secondTry.code === 403 && notAssigned.redirects.length === 1,
        'issuer-withheld write: retry is bounded (403, no second prompt, no loop)',
        secondTry && secondTry.message);
      ok(lunchMoney.hits() === 0 && notAssigned.tokens.scope === readScope,
        'issuer-withheld write never reaches the provider and the grant stays narrow');
    });

    const cancelled = stepUpProvider(await oauth.issueTokens(readScope, resource));
    await withStepUpClient(cancelled, async (client, transport) => {
      lunchMoney.resetHits();
      const writesAtStart = lunchMoney.writes();
      const firstTry = await httpRefusal(client.callTool({ name: 'prepare_lunchmoney_edit', arguments: prepareArgs }));
      ok(firstTry instanceof UnauthorizedError && cancelled.redirects.length === 1,
        'cancelled consent: the write attempt opens exactly one consent request');
      // The user cancels: no code is issued; a host that still tries to finish gets invalid_grant.
      const finish = await httpRefusal(transport.finishAuth('synthetic-cancelled-consent'));
      ok(finish instanceof Error && cancelled.tokens.scope === readScope,
        'cancelled consent fails clearly and leaves the narrow grant unchanged');
      const postsBefore = cancelled.posts;
      const secondTry = await httpRefusal(client.callTool({ name: 'prepare_lunchmoney_edit', arguments: prepareArgs }));
      const thirdTry = await httpRefusal(client.callTool({ name: 'apply_lunchmoney_edit', arguments: applyArgs }));
      ok(secondTry && secondTry.code === 403 && thirdTry && thirdTry.code === 403
          && cancelled.redirects.length === 1 && cancelled.posts - postsBefore === 2,
        'cancelled consent: repeat write attempts fail at once (one POST each, no new prompt, no loop)',
        `posts ${cancelled.posts - postsBefore}`);
      ok(lunchMoney.hits() === 0 && lunchMoney.writes() === writesAtStart,
        'cancelled consent never reaches the provider or writes');
      const stillReads = await client.callTool({ name: 'get_lunchmoney_catalog', arguments: {} });
      ok(stillReads.isError === false && stillReads.structuredContent.status === 'ok',
        'cancelled consent leaves reads working');
      const userRetry = await httpRefusal(client.callTool({ name: 'prepare_lunchmoney_edit', arguments: prepareArgs }));
      ok(userRetry instanceof UnauthorizedError && cancelled.redirects.length === 2,
        'a later user-initiated write attempt asks for consent once more (one prompt per attempt)');
      ok(lunchMoney.writes() === writesAtStart, 'still zero provider writes without a write-scoped token');
    });

    const refreshOnly = stepUpProvider(await oauth.issueTokens(readScope, resource, { refresh: true }));
    await withStepUpClient(refreshOnly, async client => {
      lunchMoney.resetHits();
      const postsAtConnect = refreshOnly.posts;
      const writesAtConnect = lunchMoney.writes();
      const refreshesBefore = oauth.tokenRequests().filter(grant => grant === 'refresh_token').length;
      const attempt = await httpRefusal(client.callTool({ name: 'prepare_lunchmoney_edit', arguments: prepareArgs }));
      const refreshes = oauth.tokenRequests().filter(grant => grant === 'refresh_token').length - refreshesBefore;
      ok(attempt && attempt.code === 403 && /after trying upscoping/.test(attempt.message)
          && refreshes === 1 && refreshOnly.redirects.length === 0 && refreshOnly.posts === 2 + postsAtConnect,
        'narrow refresh grant: one refresh, one retry, then a clear bounded 403 (no loop)',
        attempt && `${attempt.message}; posts ${refreshOnly.posts - postsAtConnect}`);
      ok(refreshOnly.tokens.scope === readScope && typeof refreshOnly.tokens.refresh_token === 'string',
        'narrow refresh grant stays narrow after the step-up attempt');
      const again = await httpRefusal(client.callTool({ name: 'apply_lunchmoney_edit', arguments: applyArgs }));
      const refreshesAgain = oauth.tokenRequests().filter(grant => grant === 'refresh_token').length - refreshesBefore;
      ok(again && again.code === 403 && refreshesAgain === 1 && refreshOnly.redirects.length === 0
          && refreshOnly.posts === 3 + postsAtConnect,
        'narrow refresh grant: a repeat write fails at once without another refresh, prompt or retry');
      ok(lunchMoney.hits() === 0 && lunchMoney.writes() === writesAtConnect,
        'narrow refresh grant never reaches the provider or writes without fresh consent');
    });

    const getMcp = await fetch(resource, {
      headers: { authorization: `Bearer ${accessToken}` }, redirect: 'manual',
    });
    ok(getMcp.status === 405, 'GET cannot retrieve a second MCP packet URL',
      `status ${getMcp.status}`);
    const badOrigin = await mcp({
      authorization: `Bearer ${accessToken}`,
      origin: 'https://attacker.example',
    }, initialize);
    ok(badOrigin.status === 403, 'untrusted browser origin is rejected');
  });
  filesUnchanged('authenticated OAuth MCP');

  console.log('\n=== write step-up classifier and tool-level defense in depth ===');
  {
    const C = AssistantOAuth.classifyToolCalls;
    const call = name => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } });
    ok(C(call('apply_lunchmoney_edit')) === 'write' && C(call('prepare_lunchmoney_edit')) === 'write',
      'classifier flags both write tools');
    ok(C(call('get_lunchmoney_catalog')) === 'other' && C(call('get_atlas_current')) === 'other'
        && C({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) === 'other'
        && C({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) === 'other',
      'classifier leaves read tools and non-call methods alone');
    ok(C(call('Apply_LunchMoney_Edit')) === 'other',
      'classifier is exact-name (an unknown tool name is not dispatched by the SDK either)');
    ok(C([call('get_lunchmoney_catalog'), call('apply_lunchmoney_edit')]) === 'write'
        && C([null, 1, 'x', [], call('prepare_lunchmoney_edit')]) === 'write',
      'classifier scans every batch member');
    ok(C({ method: 'tools/call', params: null }) === 'invalid'
        && C({ method: 'tools/call' }) === 'invalid'
        && C({ method: 'tools/call', params: { name: 7 } }) === 'invalid'
        && C([call('apply_lunchmoney_edit'), { method: 'tools/call', params: [] }]) === 'invalid',
      'classifier fails closed on unclassifiable tools/call');
    ok(C(undefined) === 'other' && C(null) === 'other' && C([]) === 'other' && C('x') === 'other',
      'classifier never throws on empty or non-object bodies');

    const server = AssistantMcp.createServer(async () => null, {
      auth: { principal: 'atlas-owner-test', scopes: [AssistantMcp.REQUIRED_SCOPE, LunchMoney.READ_SCOPE] },
      lunchMoney: { invoke: async () => { throw new Error('provider must not be called'); } },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'atlas-defense-in-depth', version: '1.0.0' });
    await server.connect(serverSide);
    await client.connect(clientSide);
    try {
      const prepare = await client.callTool({ name: 'prepare_lunchmoney_edit',
        arguments: { transactionRef: 'tx-' + 'e'.repeat(24), changes: { notes: 'no' } } });
      const apply = await client.callTool({ name: 'apply_lunchmoney_edit',
        arguments: { previewId: 'edit-' + 'e'.repeat(48), confirmed: true } });
      ok(prepare.isError === true && prepare.structuredContent.reason === 'transaction-write-scope-required'
          && apply.isError === true && apply.structuredContent.reason === 'transaction-write-scope-required',
        'tool-level write-scope check still refuses when the HTTP step-up is bypassed');
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  }

  console.log('\n=== source does not recompute financial answers ===');
  {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'assistant-packet.js'), 'utf8');
    ok(/Forecast\.recommend/.test(src) && /Forecast\.startingCashAmount/.test(src),
      'packet builder calls incumbent Forecast functions');
    ok(!/function recommendWeekly/.test(src) && !/binary search/.test(src),
      'packet builder does not contain a second weekly-cap solver');
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    ok(/Assistant\.buildPacket/.test(serverSrc),
      'server serves the packet builder rather than inline maths');
    ok(/AssistantMcp\.handleHttp/.test(serverSrc) && /\/assistant\/mcp/.test(serverSrc),
      'server MCP route delegates to the SDK adapter rather than inventing figures');
    ok(/assistantAuthed/.test(serverSrc)
        && /MCP_BEARER_AUTH/.test(serverSrc)
        && /hfd_session/.test(serverSrc),
      'static assistant, OAuth MCP, and browser session remain separate gates');
    const oauthSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'assistant-oauth.js'), 'utf8');
    ok(/jwtVerify/.test(oauthSrc) && !/introspection_endpoint|token\/introspect/.test(oauthSrc),
      'OAuth resource server verifies JWTs locally and has no introspection path');
    ok(!/issuer:\s*config\.issuer\.href/.test(oauthSrc),
      'JWT issuer verification does not use URL.href');
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const architecture = fs.readFileSync(path.join(ROOT, 'ARCHITECTURE.md'), 'utf8');
    ok(/issuer-signed JWT access tokens/.test(readme)
        && /Opaque access tokens are not supported/.test(readme)
        && /does not introspect/.test(readme),
      'README constrains the provider contract to issuer-signed JWT access tokens');
    ok(/issuer-signed JWT access tokens/.test(architecture)
        && /does not introspect opaque tokens/.test(architecture),
      'ARCHITECTURE constrains MCP to issuer-signed JWT access tokens with no introspection');
  }

  console.log('\n=== Render blueprint declares assistant auth configuration without values ===');
  {
    const render = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
    ok(/key:\s*ATLAS_ASSISTANT_TOKEN[\s\S]*?sync:\s*false/.test(render),
      'Render declares ATLAS_ASSISTANT_TOKEN as owner-supplied');
    ok(!/key:\s*ATLAS_ASSISTANT_TOKEN[\s\S]*?value:/.test(render),
      'Render does not assign an assistant token value');
    for (const key of ['ATLAS_MCP_RESOURCE_URL', 'ATLAS_OAUTH_ISSUER', 'ATLAS_OAUTH_JWKS_URI']) {
      ok(new RegExp(`key:\\s*${key}[\\s\\S]*?sync:\\s*false`).test(render),
        `Render declares ${key} as owner-supplied`);
    }
  }

  console.log('\n=== source-check receipt: projection is bounded, closed and fail-closed ===');
  {
    const T_EVIDENCE = '2026-08-24T10:00:00.000Z';
    const T_ATTEMPT = '2026-08-24T12:00:00.000Z';
    const CACHE_NOTE = 'Source evidence is process-local warm reuse; it can disappear on restart, sleep or deploy.';
    const receiptOf = (sourceCheck, now) => Assistant.buildPacket({
      data: syntheticObligationData({}),
      periods: null,
      questionsMarkdown: '',
      now: now || T_ATTEMPT,
      env: {},
      ...(sourceCheck === undefined ? {} : { sourceCheck }),
    }).metadata.sourceCheck;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    ok(same(receiptOf(undefined), {
      outcome: 'unavailable', source: null, qualified: false,
      evidenceCheckedAt: null, attemptedAt: null, reason: 'no-provider-check', cacheNote: null,
    }), 'no captured check projects the explicit unavailable form');
    ok(same(receiptOf({ check: null, attemptedAt: T_ATTEMPT }), {
      outcome: 'unavailable', source: null, qualified: false,
      evidenceCheckedAt: null, attemptedAt: null, reason: 'no-provider-check', cacheNote: null,
    }), 'off/fixture serve (no check fired) is unavailable with a null attempt time, never a success form');
    ok(same(receiptOf({ check: { source: 'provider', qualified: true, checkedAt: T_EVIDENCE }, attemptedAt: T_ATTEMPT }), {
      outcome: 'qualified', source: 'provider', qualified: true,
      evidenceCheckedAt: T_EVIDENCE, attemptedAt: T_ATTEMPT, reason: null, cacheNote: null,
    }), 'coherent qualified provider check projects qualified with its original evidence time');
    const memory = receiptOf({ check: { source: 'memory', qualified: true, checkedAt: T_EVIDENCE }, attemptedAt: T_ATTEMPT });
    ok(memory && memory.outcome === 'qualified' && memory.source === 'memory'
      && memory.evidenceCheckedAt === T_EVIDENCE && memory.attemptedAt === T_ATTEMPT
      && memory.cacheNote === CACHE_NOTE,
      'memory replay keeps the original evidence time, a separate attempt time, and the fixed cache disclosure');
    ok(same(receiptOf({ check: { source: 'provider', qualified: false, checkedAt: T_EVIDENCE }, attemptedAt: T_ATTEMPT }), {
      outcome: 'unqualified', source: 'provider', qualified: false,
      evidenceCheckedAt: T_EVIDENCE, attemptedAt: T_ATTEMPT, reason: 'reconciliation-not-ready', cacheNote: null,
    }), 'a check that ran but did not qualify is unqualified, with its evidence time');
    ok(same(receiptOf({ check: { source: 'provider', qualified: false, checkedAt: null }, attemptedAt: T_ATTEMPT }), {
      outcome: 'failed', source: 'provider', qualified: false,
      evidenceCheckedAt: null, attemptedAt: T_ATTEMPT, reason: 'provider-check-failed', cacheNote: null,
    }), 'a captured failure with no evidence time is failed, distinct from never-checked');

    // Validation amendment: nothing malformed or contradictory may qualify.
    const invalid = {
      outcome: 'unavailable', source: null, qualified: false,
      evidenceCheckedAt: null, attemptedAt: T_ATTEMPT, reason: 'invalid-source-check', cacheNote: null,
    };
    for (const [label, check] of [
      ['qualified without evidence time', { source: 'provider', qualified: true, checkedAt: null }],
      ['qualified from an unlisted source', { source: 'cache', qualified: true, checkedAt: T_EVIDENCE }],
      ['qualified without a source', { source: null, qualified: true, checkedAt: T_EVIDENCE }],
      ['qualified with a non-timestamp evidence time', { source: 'provider', qualified: true, checkedAt: 'yesterday' }],
      ['qualified with an impossible evidence date', { source: 'provider', qualified: true, checkedAt: '2026-13-40T99:99:99.000Z' }],
      ['string qualified flag', { source: 'provider', qualified: 'true', checkedAt: T_EVIDENCE }],
      ['numeric qualified flag', { source: 'provider', qualified: 1, checkedAt: T_EVIDENCE }],
      ['unqualified with a malformed evidence time', { source: 'provider', qualified: false, checkedAt: 'garbage' }],
      ['non-object check', 'provider'],
      // Codex advisory on f511fc46: Date.parse normalizes impossible
      // calendar dates, and a negative outcome from an unlisted source is
      // a malformed capture too.
      ['qualified with a non-leap-year Feb 29 evidence time', { source: 'provider', qualified: true, checkedAt: '2026-02-29T10:00:00.000Z' }],
      ['qualified with an April 31 evidence time', { source: 'provider', qualified: true, checkedAt: '2026-04-31T10:00:00.000Z' }],
      ['unqualified from an unlisted source', { source: 'cache', qualified: false, checkedAt: T_EVIDENCE }],
      ['failed-shaped capture from an unlisted source', { source: 'cache', qualified: false, checkedAt: null }],
    ]) {
      ok(same(receiptOf({ check, attemptedAt: T_ATTEMPT }), invalid),
        `malformed capture fails closed: ${label}`);
    }
    const raw = receiptOf({
      check: { source: 'provider', qualified: false, checkedAt: T_EVIDENCE, reason: 'RAW-PROVIDER-ERROR-TEXT', note: 'SYNTHETIC-RAW-NOTE' },
      attemptedAt: T_ATTEMPT,
    });
    ok(raw && raw.reason === 'reconciliation-not-ready'
      && !JSON.stringify(raw).includes('RAW-PROVIDER-ERROR-TEXT')
      && !JSON.stringify(raw).includes('SYNTHETIC-RAW-NOTE'),
      'receipt never forwards raw overlay/error text or arbitrary check fields');
    const outcomeA = receiptOf({ check: { source: 'provider', qualified: false, checkedAt: T_EVIDENCE }, attemptedAt: T_ATTEMPT },
      '2026-08-24T12:00:00.000Z');
    const outcomeB = receiptOf({ check: { source: 'provider', qualified: false, checkedAt: T_EVIDENCE }, attemptedAt: T_ATTEMPT },
      '2026-09-01T00:00:00.000Z');
    ok(outcomeA && outcomeB && outcomeA.outcome === 'unqualified' && outcomeB.outcome === 'unqualified',
      'receipt outcome keys off the captured check, never off generatedAt');

    // The receipt is the only change: the rest of the packet is untouched.
    const plain = Assistant.buildPacket({
      data: syntheticObligationData({}), periods: null, questionsMarkdown: '', now: T_ATTEMPT, env: {},
    });
    const withReceipt = Assistant.buildPacket({
      data: syntheticObligationData({}), periods: null, questionsMarkdown: '', now: T_ATTEMPT, env: {},
      sourceCheck: { check: { source: 'provider', qualified: true, checkedAt: T_EVIDENCE }, attemptedAt: T_ATTEMPT },
    });
    const strip = packet => { const c = clone(packet); delete c.metadata.sourceCheck; return JSON.stringify(c); };
    ok(strip(plain) === strip(withReceipt),
      'adding the receipt changes nothing else in the packet');
    ok(JSON.stringify(plain.uncertainty) === JSON.stringify(withReceipt.uncertainty),
      'uncertainty block is byte-identical with and without a receipt');
    ok(Assistant.looksSanitized(withReceipt) && !forbiddenBlob(withReceipt),
      'packet with a receipt still passes the sanitization gate');
    // Control for the calendar round-trip: a genuine leap day stays valid.
    ok(same(receiptOf({ check: { source: 'provider', qualified: true, checkedAt: '2024-02-29T10:00:00.000Z' }, attemptedAt: T_ATTEMPT }),
      { outcome: 'qualified', source: 'provider', qualified: true,
        evidenceCheckedAt: '2024-02-29T10:00:00.000Z', attemptedAt: T_ATTEMPT,
        reason: null, cacheNote: null }),
      'a genuine leap-day evidence time still projects qualified');
  }

  console.log('\n=== source-check receipt over HTTP: unavailable and failed are distinct ===');
  await withAtlas({ ATLAS_ASSISTANT_TOKEN: ASSISTANT_TOKEN }, async ({ base }) => {
    const res = await fetch(`${base}/assistant/current`, {
      headers: { authorization: `Bearer ${ASSISTANT_TOKEN}` },
    });
    const packet = await res.json();
    const receipt = packet.metadata && packet.metadata.sourceCheck;
    ok(res.status === 200 && receipt && receipt.outcome === 'unavailable'
      && receipt.reason === 'no-provider-check' && receipt.source === null
      && receipt.evidenceCheckedAt === null && receipt.attemptedAt === null,
      'canonical-mode packet carries the explicit unavailable receipt with a null attempt time, not a success form');
    const authed = await login(base);
    const talkRes = await fetch(`${base}/talk/context`, { headers: { cookie: authed.cookie } });
    const talkPacket = await talkRes.json();
    ok(talkRes.status === 200 && talkPacket.metadata.sourceCheck
      && talkPacket.metadata.sourceCheck.outcome === 'unavailable',
      'talk context packet carries the same receipt block');
    const anon = await fetch(`${base}/assistant/current`, { redirect: 'manual' });
    ok(anon.status === 401, 'receipt is only served behind the existing Bearer gate');
  });
  await withAtlas({
    ATLAS_ASSISTANT_TOKEN: ASSISTANT_TOKEN,
    ATLAS_LIVE_OVERLAY: 'live',
  }, async ({ base }) => {
    const res = await fetch(`${base}/assistant/current`, {
      headers: { authorization: `Bearer ${ASSISTANT_TOKEN}` },
    });
    const packet = await res.json();
    const receipt = packet.metadata && packet.metadata.sourceCheck;
    ok(res.status === 200 && receipt && receipt.outcome === 'failed'
      && receipt.reason === 'provider-check-failed' && receipt.evidenceCheckedAt === null
      && typeof receipt.attemptedAt === 'string',
      'a failed provider check is a failed receipt with an attempt time and no evidence time');
  });
  await withAtlas({}, async ({ base }) => {
    const res = await fetch(`${base}/assistant/current`, {
      headers: { authorization: `Bearer ${ASSISTANT_TOKEN}` },
    });
    const body = await res.json().catch(() => null);
    ok(res.status === 503 && body && !body.metadata,
      'unconfigured assistant token still refuses with 503 and no packet');
  });

  console.log('\n=== source-check receipt reaches the MCP consumer unchanged ===');
  await withOAuthAtlas(async ({ resource, oauth }) => {
    const token = await oauth.sign(resource);
    await withOfficialMcp(resource, token, async (client) => {
      const called = await client.callTool({ name: AssistantMcp.TOOL_NAME, arguments: {} });
      const receipt = called.structuredContent && called.structuredContent.metadata.sourceCheck;
      ok(called.isError === false && receipt && receipt.outcome === 'unavailable'
        && receipt.reason === 'no-provider-check' && receipt.qualified === false,
        'MCP get_atlas_current packet carries the same receipt projector output');
    });
  });

  console.log('\n=== source-check receipt reaches the Talk ask packet (live fixture) ===');
  {
    const ObsHarness = require('./test-server-observation-memory.js');
    const mock = await ObsHarness.provider();
    const captured = [];
    const geminiServer = http.createServer((req, res) => {
      let rawBody = '';
      req.on('data', chunk => { rawBody += chunk; });
      req.on('end', () => {
        captured.push(rawBody);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          candidates: [{
            content: {
              parts: [{ text: JSON.stringify({
                status: 'explained',
                claims: [{ path: 'authority.planner', equals: 'Forecast' }],
              }) }],
              role: 'model',
            },
            finishReason: 'STOP',
          }],
        }));
      });
    });
    await new Promise(resolve => geminiServer.listen(0, '127.0.0.1', resolve));
    const geminiUrl = `http://127.0.0.1:${geminiServer.address().port}`;
    const port = await freePort();
    const child = spawn(process.execPath, [
      '--require', path.join(ROOT, 'test', 'test-server-observation-memory.js'),
      path.join(ROOT, 'server.js'),
    ], {
      cwd: ROOT,
      env: {
        ...ObsHarness.environment(mock.base),
        PORT: String(port),
        SITE_PASSWORD: ObsHarness.PASS,
        SESSION_SECRET: SECRET,
        ATLAS_ASSISTANT_TOKEN: ObsHarness.TOKEN,
        ATLAS_SYNTHETIC_OBSERVATION_PRELOAD: '1',
        ATLAS_TALK_GEMINI_API_KEY: 'synthetic-talk-gemini-key-32chars!!',
        ATLAS_TALK_GEMINI_BASE_URL: geminiUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', () => {});
    try {
      await new Promise((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error('talk fixture server start timeout')), 20000);
        child.stdout.on('data', chunk => {
          out += chunk;
          if (/listening/.test(out)) { clearTimeout(timer); resolve(); }
        });
        child.on('exit', code => { clearTimeout(timer); reject(new Error(`talk fixture server exited ${code}`)); });
      });
      const base = `http://127.0.0.1:${port}`;
      const loginRes = await fetch(`${base}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `password=${encodeURIComponent(ObsHarness.PASS)}`,
      });
      const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
      ok(/^hfd_session=/.test(cookie), 'talk fixture login issues a session');
      const ask = await fetch(`${base}/talk/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ question: 'What should I know today?' }),
      });
      ok(ask.status === 200, 'talk ask succeeds against the live fixture', `status ${ask.status}`);
      const match = /sourceCheck\\":(\{[^{}]*\})/.exec(captured.join('\n'));
      const talkReceipt = match ? JSON.parse(match[1].replace(/\\"/g, '"')) : null;
      ok(talkReceipt && talkReceipt.outcome === 'qualified' && talkReceipt.source === 'provider'
        && talkReceipt.qualified === true && talkReceipt.evidenceCheckedAt === ObsHarness.CLOCK,
        'the packet Gemini receives carries the qualified provider receipt with the original evidence time');
      const current = await fetch(`${base}/assistant/current`, {
        headers: { authorization: `Bearer ${ObsHarness.TOKEN}` },
      });
      const currentPacket = await current.json();
      ok(currentPacket.metadata.sourceCheck
        && currentPacket.metadata.sourceCheck.outcome === 'qualified'
        && currentPacket.metadata.sourceCheck.evidenceCheckedAt === ObsHarness.CLOCK,
        'assistant/current on the same server agrees with the Talk packet receipt');
    } finally {
      child.kill('SIGTERM');
      await new Promise(done => geminiServer.close(() => done()));
      await mock.close();
    }
  }

  filesUnchanged('end of suite');
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
