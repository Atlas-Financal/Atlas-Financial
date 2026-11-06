'use strict';
// Household financial dashboard — password-gated.
//
// Design notes:
//  * Fails closed. Without SITE_PASSWORD and SESSION_SECRET the server refuses
//    to start, so a misconfigured deploy can never serve the data publicly.
//  * The financial data is served only to an authenticated session. Nothing
//    sensitive sits in the static directory.
//  * Sessions are stateless: an HMAC-signed cookie, so a restart (Render free
//    tier sleeps) does not force a re-login mid-session.
//  * GET /assistant/current remains a dedicated static-Bearer consumer.
//    POST /assistant/mcp is separate again: an OAuth-protected MCP resource
//    exposing the same packet as one read-only tool. GET /talk/context is the
//    household-session consumer of that same packet. POST /talk/ask is the
//    session-only Gemini explainer for Talk, with an ephemeral in-memory
//    turn buffer keyed to the authenticated session; GET /talk/capability
//    says whether that path is configured. Conversation history is
//    conversational context only and is not household-financial evidence.
//    POST /talk/ask may emit allowlisted SSE progress phases when the
//    browser asks for text/event-stream, then the same verified JSON
//    body. Gemini tokens are never streamed. Browser, static assistant,
//    and OAuth credentials do not unlock one another. The Talk model
//    secret never reaches the browser.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const SnapshotBalances = require('./scripts/snapshot-balances.js');
const LivePlan = require('./scripts/live-plan.js');
const ServerLiveRefresh = require('./scripts/server-live-refresh.js');
const SettlementEvidenceServing = require('./scripts/settlement-evidence-serving.js');
// Default-inactive: constructed with NO dependency, so attach() returns
// the served object unchanged and adds no settlement fields.
// Browser-only opt-in composition is separate and application-local; this
// shared consumer path never reads settlement configuration or storage.
const settlementEvidenceServing = SettlementEvidenceServing.createSettlementEvidenceServing();
const Assistant = require('./scripts/assistant-packet.js');
const RunningBuild = require('./scripts/running-build.js');
const AssistantMcp = require('./scripts/assistant-mcp.js');
const LunchMoneyAssistant = require('./scripts/assistant-lunchmoney.js');
const StandingRuntime = require('./scripts/assistant-standing-runtime.js');
const AssistantOAuth = require('./scripts/assistant-oauth.js');
const TalkGemini = require('./scripts/talk-gemini.js');
const TalkPresentation = require('./scripts/talk-presentation.js');
const TalkHypothetical = require('./scripts/talk-hypothetical.js');
const TalkSession = require('./scripts/talk-session.js');
const TalkStream = require('./scripts/talk-stream.js');
const TalkWhy = require('./scripts/talk-why.js');

const PREACTIVATION_BOOT = Symbol('sealed-preactivation-boot');
const SESSION_REVOCATION = Symbol('composed-session-revocation');
// General construction is history-unknown even without settlement dependencies.
function createApplication(options = {}) {
const environment = options.env || process.env;
const baseSource = options.baseSource;
const preactivationOnly = options[PREACTIVATION_BOOT] === true;
if (preactivationOnly && Object.hasOwn(options, 'settlement')) throw new TypeError('sealed preactivation rejects settlement dependencies');

const PASSWORD = environment.SITE_PASSWORD;
const SECRET = environment.SESSION_SECRET;
const ASSISTANT_TOKEN = environment.ATLAS_ASSISTANT_TOKEN || '';
const TALK_GEMINI_KEY = environment.ATLAS_TALK_GEMINI_API_KEY || '';
const SESSION_HOURS = 24 * 14;
const MCP_OAUTH = AssistantOAuth.readConfig(environment);
const STANDING_CORRECTIONS = StandingRuntime.fromEnv({ resource: MCP_OAUTH.resource?.href });
const lunchMoneyService = LunchMoneyAssistant.createService({ standingCorrections: STANDING_CORRECTIONS });
const lunchMoneyAssistant = {
  ...lunchMoneyService,
  invoke(operation, ...args) {
    const invoke = () => lunchMoneyService.invoke(operation, ...args);
    // Existing writer, unchanged authority/arguments/outcome. Invalidate reads
    // around every attempt, including an ambiguous or rejected provider result.
    return operation === 'apply' || operation === 'applyStanding'
      ? ServerLiveRefresh.withProviderWrite(invoke) : invoke();
  },
};
// Tools, metadata and HTTP step-up share one validated default-off capability.
MCP_OAUTH.standingCorrectionsEnabled = lunchMoneyAssistant.standingEnabled === true;
const MCP_BEARER_AUTH = MCP_OAUTH.configured
  ? AssistantOAuth.createBearerMiddleware(MCP_OAUTH)
  : null;
const MCP_WRITE_STEP_UP = MCP_OAUTH.configured
  ? AssistantOAuth.createWriteStepUp(MCP_OAUTH)
  : null;

if (!PASSWORD || PASSWORD.length < 8) {
  console.error('FATAL: SITE_PASSWORD is not set, or is shorter than 8 characters.');
  process.exit(1);
}
if (!SECRET || SECRET.length < 16) {
  console.error('FATAL: SESSION_SECRET is not set, or is shorter than 16 characters.');
  process.exit(1);
}
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
if (ASSISTANT_TOKEN && ASSISTANT_TOKEN.length < Assistant.TOKEN_MIN_LENGTH) {
  console.error('FATAL: ATLAS_ASSISTANT_TOKEN is set but shorter than 32 characters.');
  process.exit(1);
}
if (ASSISTANT_TOKEN && sameSecret(ASSISTANT_TOKEN, PASSWORD)) {
  console.error('FATAL: ATLAS_ASSISTANT_TOKEN must not reuse SITE_PASSWORD.');
  process.exit(1);
}
if (ASSISTANT_TOKEN && sameSecret(ASSISTANT_TOKEN, SECRET)) {
  console.error('FATAL: ATLAS_ASSISTANT_TOKEN must not reuse SESSION_SECRET.');
  process.exit(1);
}
if (TALK_GEMINI_KEY && TALK_GEMINI_KEY.length < TalkGemini.TOKEN_MIN_LENGTH) {
  console.error('FATAL: ATLAS_TALK_GEMINI_API_KEY is set but shorter than 32 characters.');
  process.exit(1);
}
if (TALK_GEMINI_KEY && sameSecret(TALK_GEMINI_KEY, PASSWORD)) {
  console.error('FATAL: ATLAS_TALK_GEMINI_API_KEY must not reuse SITE_PASSWORD.');
  process.exit(1);
}
if (TALK_GEMINI_KEY && sameSecret(TALK_GEMINI_KEY, SECRET)) {
  console.error('FATAL: ATLAS_TALK_GEMINI_API_KEY must not reuse SESSION_SECRET.');
  process.exit(1);
}
if (TALK_GEMINI_KEY && ASSISTANT_TOKEN && sameSecret(TALK_GEMINI_KEY, ASSISTANT_TOKEN)) {
  console.error('FATAL: ATLAS_TALK_GEMINI_API_KEY must not reuse ATLAS_ASSISTANT_TOKEN.');
  process.exit(1);
}

const talkSessions = TalkSession.createSessionContext({ secret: SECRET });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render terminates TLS in front of us
const formParser = express.urlencoded({ extended: false, limit: '8kb', inflate: false });
// Compressed request bodies are rejected before any parser runs: this surface
// accepts only uncompressed input, the same refusal the settlement router
// already makes. A malformed compressed stream otherwise reaches body-parser's
// inflater and surfaces through the default error handler as an HTML error
// page (with stack detail outside production) instead of one fixed refusal,
// and a well-formed compressed body is silently decompressed and accepted.
function rejectCompressed(req, res, next) {
  const encoding = req.get('Content-Encoding');
  if (encoding && encoding.trim().toLowerCase() !== 'identity') {
    return res.status(415).json({ status: 'invalid-request' });
  }
  return formParser(req, res, next);
}
app.use((req, res, next) => /^\/settlement(?:\/|$)/i.test(req.path) ? next() : rejectCompressed(req, res, next));

// ---------------------------------------------------------------- security
app.use((req, res, next) => {
  res.set({
    'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  next();
});

app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

// ---------------------------------------------------------------- sessions
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function authed(req) {
  return verify(readCookie(req, 'hfd_session')) !== null;
}
// FOUNDATION - NOT COMPLETION: available only from this signed login, never
// from a caller-supplied actor or an expiry-only legacy cookie. This is not
// person identity, settlement authorization, or permission to read old receipts.
// Every settlement consumer additionally requires the trusted household policy.
function sessionActor(req) {
  let token;
  try { token = readCookie(req, 'hfd_session'); } catch { return null; }
  if (typeof token !== 'string' || token.split('.').length !== 2) return null;
  const payload = verify(token);
  if (!payload || !Number.isSafeInteger(payload.exp)
      || typeof payload.sid !== 'string' || !/^[0-9a-f]{64}$/.test(payload.sid)) return null;
  return `session-${payload.sid}`;
}
// The recovery final authority's private session view: the same
// HMAC-verified payload sessionActor trusts, projected to exactly what
// the final decision may see — the session actor, the DIGEST of the
// session id (never the id itself), and the verified expiry. A legacy
// expiry-only cookie supplies no recovery authority here either. Built
// only inside this module; the settlement seam receives it as an opaque
// capability and the controller never sees it.
function sessionAuthority(req) {
  let token;
  try { token = readCookie(req, 'hfd_session'); } catch { return null; }
  if (typeof token !== 'string' || token.split('.').length !== 2) return null;
  const payload = verify(token);
  if (!payload || !Number.isSafeInteger(payload.exp)
      || typeof payload.sid !== 'string' || !/^[0-9a-f]{64}$/.test(payload.sid)) return null;
  return Object.freeze({ actorId: `session-${payload.sid}`,
    sidDigest: crypto.createHash('sha256').update(payload.sid).digest('hex'),
    expiresAt: payload.exp });
}
function assistantConfigured() {
  return Assistant.tokenConfigured({ ATLAS_ASSISTANT_TOKEN: ASSISTANT_TOKEN });
}
function readBearer(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(\S+)$/.exec(header);
  return match ? match[1] : null;
}
function assistantAuthed(req) {
  if (!assistantConfigured()) return false;
  const suppliedRaw = readBearer(req);
  if (typeof suppliedRaw !== 'string') return false;
  const supplied = Buffer.from(suppliedRaw);
  const actual = Buffer.from(ASSISTANT_TOKEN);
  if (supplied.length !== actual.length) return false;
  return crypto.timingSafeEqual(supplied, actual);
}
function assistantHttpGuard(req, res) {
  const ip = req.ip || 'unknown';
  if (!assistantConfigured()) {
    res.status(503).json({ error: 'assistant unavailable' });
    return true;
  }
  if (tooManyAttempts(ip)) {
    res.status(429).json({ error: 'too many attempts' });
    return true;
  }
  if (!assistantAuthed(req)) {
    noteAttempt(ip);
    assistantUnauthorized(res);
    return true;
  }
  return false;
}
async function buildCurrentAssistantPacket(req, res) {
  // Capture the serve lifecycle result so the packet can publish its bounded
  // source-check receipt (metadata.sourceCheck). attemptedAt is the serve
  // COMPLETION time — when this read's serve settled — never the provider
  // fetch start; the check's own checkedAt carries the evidence time. In
  // off/fixture modes no check ever fires and the receipt projects its
  // explicit unavailable form.
  let capturedCheck = null;
  const served = await servedAtlasData(req, res, {
    onCheck(check) { capturedCheck = check; },
  });
  return Assistant.buildPacket({
    data: served,
    env: environment,
    now: new Date().toISOString(),
    sourceCheck: { check: capturedCheck, attemptedAt: new Date().toISOString() },
  });
}
// Install the opted-in awaited append before the incumbent synchronous logout
// handler. A failed append still reaches that handler's cookie/Talk cleanup,
// with a bounded refusal instead of an acknowledged logout redirect.
if (options[SESSION_REVOCATION]) {
  const revokeSession = options[SESSION_REVOCATION];
  app.post('/logout', async (req, _res, next) => {
    const authority = sessionAuthority(req);
    if (authority) {
      try { await revokeSession(authority.sidDigest); }
      catch { req.settlementLogoutUnavailable = true; }
    }
    next();
  });
}
// Secure is mandatory in production (Render is always HTTPS) but must be
// omitted over plain http, or a local test session can never be sent back.
function secureFlag(req) {
  return (req.secure || req.get('x-forwarded-proto') === 'https') ? ' Secure;' : '';
}

// Simple in-memory throttle. Enough to stop guessing; resets on restart.
const attempts = new Map();
function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > 15 * 60 * 1000) { attempts.delete(ip); return false; }
  return rec.count >= 8;
}
function noteAttempt(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > 15 * 60 * 1000) attempts.set(ip, { count: 1, first: Date.now() });
  else rec.count++;
}

// ---------------------------------------------------------------- login
const LOGIN_HTML = (error) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Sign in</title><link rel="stylesheet" href="/styles.css"></head>
<body class="login-page"><main class="login-card">
<h1>Household finances</h1>
<p class="muted">This page is private. Enter the shared password to continue.</p>
${error ? `<p class="login-error" role="alert">${error}</p>` : ''}
<form method="POST" action="/login" autocomplete="on">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Sign in</button>
</form>
</main></body></html>`;

app.get('/login', (req, res) => {
  if (authed(req)) return res.redirect('/');
  res.type('html').send(LOGIN_HTML(null));
});

app.post('/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (tooManyAttempts(ip)) {
    return res.status(429).type('html').send(LOGIN_HTML('Too many attempts. Wait 15 minutes.'));
  }
  const supplied = Buffer.from(String(req.body.password || ''));
  const actual = Buffer.from(PASSWORD);
  const ok = supplied.length === actual.length && crypto.timingSafeEqual(supplied, actual);
  if (!ok) {
    noteAttempt(ip);
    return res.status(401).type('html').send(LOGIN_HTML('That password is not right.'));
  }
  attempts.delete(ip);
  const token = sign({
    exp: Date.now() + SESSION_HOURS * 3600 * 1000,
    sid: crypto.randomBytes(32).toString('hex'),
  });
  res.set('Set-Cookie',
    `hfd_session=${encodeURIComponent(token)}; HttpOnly;${secureFlag(req)} SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`);
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  let token;
  try { token = readCookie(req, 'hfd_session'); } catch { /* malformed cookie has no signed identity */ }
  if (token) talkSessions.clear(talkSessions.keyFromToken(token));
  res.set('Set-Cookie', `hfd_session=; HttpOnly;${secureFlag(req)} SameSite=Lax; Path=/; Max-Age=0`);
  if (req.settlementLogoutUnavailable === true) return res.status(503).json({ status: 'unavailable' });
  res.redirect('/login');
});

// The health check has to answer before the gate, not behind it. render.yaml
// declares /healthz as the health-check path, but sitting below the gate it
// only ever returned a 302 to the login page — a platform that requires a 2xx
// would mark the service unhealthy and restart it in a loop. It serves the
// literal string "ok" and reads nothing, so this widens no data surface.
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

// The server's private session authority rides along with any supplied
// settlement composition; it is never caller-supplied, so a composition
// cannot substitute its own view of the caller's session.
const settlementDependency = options.settlement === undefined ? undefined
  : Object.freeze({ ...options.settlement, sessionAuthority });
const settlementHttp = require('./scripts/settlement-evidence-http').mountSettlementHttp(app, sessionActor, settlementDependency, preactivationOnly);

// OAuth protected-resource discovery is public metadata. It contains no token,
// credential, or household data. The authorization server itself is external;
// Atlas remains only the read-only resource server.
function oauthMetadata(_req, res) {
  if (!MCP_OAUTH.configured) {
    return res.status(503).json({ error: 'assistant oauth unavailable' });
  }
  return res.json(AssistantOAuth.protectedResourceMetadata(MCP_OAUTH));
}
app.get(AssistantOAuth.METADATA_PATH, oauthMetadata);
app.get(`${AssistantOAuth.METADATA_PATH}/assistant/mcp`, oauthMetadata);

// ---------------------------------------------------------------- data cache
// Shared by the browser /data.json session route and the assistant packet.
// Overlay is on-demand GET-only; this never writes canonical state.
let cachedData = null;
let cachedAt = 0;
function loadCanonicalData() {
  const file = path.join(__dirname, 'data.json');
  const stat = fs.statSync(file);
  if (!cachedData || stat.mtimeMs > cachedAt) {
    cachedData = JSON.parse(fs.readFileSync(file, 'utf8'));
    cachedAt = stat.mtimeMs;
  }
  return cachedData;
}
// G2 (#725): the last served document whose live overlay applied with a
// Savings observation, held in this process's memory only (never browser
// storage or disk). A later failed refresh is served through
// LivePlan.withCarriedSavingsEvidence, which keeps that dated evidence and
// marks it carried; the logic lives there, not here.
let lastGoodServed = null;
function withRetainedSavingsEvidence(served) {
  if (served && served.liveOverlay && served.liveOverlay.applied === true
      && served.plan && served.plan.savingsPoolObservation) {
    lastGoodServed = served;
    return served;
  }
  return LivePlan.withCarriedSavingsEvidence(served, lastGoodServed);
}
async function servedAtlasData(req, res, options = {}) {
  const controller = new AbortController();
  const cancel = () => { if (!res || !res.writableEnded) controller.abort(); };
  req?.once('aborted', cancel);
  res?.once('close', cancel);
  if (req?.aborted || res?.destroyed) controller.abort();
  try {
    const served = baseSource ? await baseSource()
      : await ServerLiveRefresh.serve(loadCanonicalData(), environment, { ...options, signal: controller.signal });
    return await settlementEvidenceServing.attach(withRetainedSavingsEvidence(served));
  } finally {
    req?.removeListener('aborted', cancel);
    res?.removeListener('close', cancel);
  }
}

// ---------------------------------------------------------------- assistant (dedicated auth; not the browser session)
function assistantUnauthorized(res) {
  res.set('WWW-Authenticate', 'Bearer realm="atlas-assistant"');
  return res.status(401).json({ error: 'not authenticated' });
}
app.get('/assistant/current', async (req, res) => {
  if (assistantHttpGuard(req, res)) return;
  try {
    res.json(await buildCurrentAssistantPacket(req, res));
  } catch (err) {
    console.error('assistant packet could not be built:', err.message);
    if (!res.destroyed) res.status(err.code?.startsWith('live-refresh-') ? 503 : 500).json({ error: 'assistant unavailable' });
  }
});
app.all('/assistant/current', (_req, res) => {
  res.set('Allow', 'GET');
  return res.status(405).json({ error: 'method not allowed' });
});

function mcpOAuthGate(req, res, next) {
  if (!MCP_OAUTH.configured || !MCP_BEARER_AUTH) {
    return res.status(503).json({ error: 'assistant oauth unavailable' });
  }
  if (!AssistantMcp.originAllowed(req.get('origin'))) {
    return res.status(403).json({ error: 'origin not allowed' });
  }
  return MCP_BEARER_AUTH(req, res, next);
}
const mcpJson = express.json({ limit: '32kb', type: 'application/json', inflate: false });
app.post('/assistant/mcp', mcpOAuthGate, (req, res, next) => {
  mcpJson(req, res, (err) => {
    if (!err) return next();
    return res.status(400).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'parse error' },
    });
  });
}, (req, res, next) => {
  // Lunch Money write tools without atlas.transactions.write get HTTP 403
  // insufficient_scope so MCP clients step up; every other request passes.
  if (!MCP_WRITE_STEP_UP) return res.status(503).json({ error: 'assistant oauth unavailable' });
  return MCP_WRITE_STEP_UP(req, res, next);
}, async (req, res) => {
  try {
    await AssistantMcp.handleHttp(req, res, {
      getPacket: () => buildCurrentAssistantPacket(req, res),
      lunchMoney: lunchMoneyAssistant,
      auth: { principal: req.auth && req.auth.extra && req.auth.extra.subject,
        scopes: req.auth && req.auth.scopes || [] },
    });
  } catch (err) {
    console.error('assistant MCP request failed');
    if (!res.headersSent) {
      return res.status(500).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: 'internal error' },
      });
    }
  }
});
app.all('/assistant/mcp', mcpOAuthGate, (_req, res) => {
  res.set('Allow', 'POST');
  return res.status(405).json({ error: 'method not allowed' });
});

// ---------------------------------------------------------------- gate
// styles.css is needed by the login page, so it stays public. Everything else
// requires a session. The assistant route has its own Bearer gate above and
// is not unlocked by a browser cookie. MCP has its own OAuth gate above.
app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/styles.css' || req.path === '/robots.txt') return next();
  if (req.path === '/assistant/current' || req.path === '/assistant/mcp') {
    return res.status(401).json({ error: 'not authenticated' });
  }
  if (authed(req)) return next();
  if (req.path === '/data.json' || req.path === '/balance-history.json'
      || req.path === '/talk/context' || req.path === '/talk/ask'
      || req.path === '/talk/capability') {
    return res.status(401).json({ error: 'not authenticated' });
  }
  return res.redirect('/login');
});

// ---------------------------------------------------------------- data
app.get('/data.json', async (req, res) => {
  // Only this session-authenticated browser route may prefer process memory.
  // Assistant/current, MCP and Talk retain the incumbent live-read preference.
  if (req.query.refresh !== undefined && req.query.refresh !== 'force') {
    return res.status(400).json({ error: 'invalid refresh option' });
  }
  try {
    // Dated openings stay on disk. An explicit overlay (ATLAS_LIVE_OVERLAY=
    // fixture|live) may replace posted/pending for today's live plan only.
    // Production read-only Lunch Money uses live mode plus owner-supplied
    // secrets. Default without that flag remains the canonical file.
    await settlementHttp.browserData(req, () => servedAtlasData(req, res, {
      preferObservation: true, forceRefresh: req.query.refresh === 'force',
      onCheck(check) {
        res.set('X-Atlas-Observation-Source', check.source);
        res.set('X-Atlas-Observation-Qualified', check.qualified ? 'true' : 'false');
        if (check.checkedAt) res.set('X-Atlas-Observation-Checked-At', check.checkedAt);
      },
    }), served => { if (!res.destroyed) res.json(served); });
  } catch (err) {
    if (err.code === 'SETTLEMENT_RUNTIME_UNAVAILABLE' || err.code === 'SETTLEMENT_COMPOSITION_UNAVAILABLE') {
      if (!res.destroyed) res.status(503).json({ error: 'data unavailable' });
    } else if (err.code === 'settlement-browser-unavailable') {
      if (!res.destroyed) res.status(err.status === 401 ? 401 : 503)
        .json({ error: err.status === 401 ? 'not authenticated' : 'data unavailable' });
    } else {
      if (err.code !== 'live-refresh-cancelled') console.error('data.json could not be read:', err.code || 'data unavailable');
      if (!res.destroyed) res.status(err.code?.startsWith('live-refresh-') ? 503 : 500).json({ error: 'data unavailable' });
    }
  }
});

// Talk context — same incumbent assistant packet, browser session only.
// Does not change /assistant/current or /assistant/mcp auth semantics.
// Browser JS must not authenticate to those assistant endpoints.
app.get('/talk/context', async (req, res) => {
  try {
    res.json(await buildCurrentAssistantPacket(req, res));
  } catch (err) {
    console.error('talk context packet could not be built:', err.message);
    res.status(500).json({ error: 'talk context unavailable' });
  }
});
app.all('/talk/context', (_req, res) => {
  res.set('Allow', 'GET');
  return res.status(405).json({ error: 'method not allowed' });
});

// Talk capability — session only. Reports whether the Gemini explainer
// path is configured. Never includes the model secret or the packet.
app.get('/talk/capability', (_req, res) => {
  res.json(TalkGemini.capability(process.env));
});
app.all('/talk/capability', (_req, res) => {
  res.set('Allow', 'GET');
  return res.status(405).json({ error: 'method not allowed' });
});

// Talk ask — session-only Gemini explainer plus authorized follow-ups.
// Builds the incumbent assistant packet (same builder as /talk/context).
// An ephemeral in-memory turn buffer is keyed to this authenticated
// session. History is conversational context only: it is not household-
// financial evidence, Forecast state, owner policy, a write, or
// permission. Follow-up amounts and named debts are filled only when
// the server can deterministically resolve them under the authorized
// contract; ambiguity is unavailable. Campaign-style verified
// follow-ups resolve only against ephemeral structured refs from a
// prior verified presentation and re-read this request's packet or
// recompute Forecast; conversation prose is not a figure source.
// Every financial answer still verifies against this request's packet
// or is computed by Forecast on current Atlas state. Client history
// fields are rejected. No durable store. Does not write.
//
// Accept: text/event-stream receives allowlisted progress phases, then
// the same verified public JSON body as a final result event. Gemini
// tokens, incomplete model JSON, and unverified prose are never written
// to the stream. Envelope failures stay JSON so the auth and body
// contract do not change.
const talkAskJson = express.json({ limit: '4kb', type: 'application/json', inflate: false });

function appendTalkSessionTurn(sessionKey, question, presented) {
  talkSessions.append(sessionKey, {
    question,
    presented: presented.answer,
    kind: presented.sessionTurn && presented.sessionTurn.kind,
    amount: presented.sessionTurn && presented.sessionTurn.amount,
    debtId: presented.sessionTurn && presented.sessionTurn.debtId,
    debtLabel: presented.sessionTurn && presented.sessionTurn.debtLabel,
    scenarios: presented.sessionTurn && presented.sessionTurn.scenarios,
    referentPaths: presented.sessionTurn && presented.sessionTurn.referentPaths,
    referentKeys: presented.sessionTurn && presented.sessionTurn.referentKeys,
    billId: presented.sessionTurn && presented.sessionTurn.billId,
    billLabel: presented.sessionTurn && presented.sessionTurn.billLabel,
    priorKind: presented.sessionTurn && presented.sessionTurn.priorKind,
    // Already-sanitized published Forecast baseline only. Not evidence.
    asOf: presented.sessionTurn && presented.sessionTurn.asOf,
    freshness: presented.sessionTurn && presented.sessionTurn.freshness,
  });
}

async function presentTalkAskTurn(parsed, sessionKey, onPhase, req, res) {
  const phase = (name) => {
    if (typeof onPhase === 'function') onPhase(name);
  };
  phase('understanding');
  phase('checking-atlas-context');
  const priorTurns = talkSessions.turns(sessionKey);
  // Identical capture to buildCurrentAssistantPacket: every packet consumer
  // shares the one receipt projector, Talk included.
  let capturedCheck = null;
  const served = await servedAtlasData(req, res, {
    onCheck(check) { capturedCheck = check; },
  });
  const packet = Assistant.buildPacket({
    data: served,
    env: process.env,
    now: new Date().toISOString(),
    sourceCheck: { check: capturedCheck, attemptedAt: new Date().toISOString() },
  });
  const atlas = {
    plan: served && served.plan,
    debts: served && served.debts,
  };
  const follow = TalkSession.resolveFollowup({
    question: parsed.question,
    priorTurn: TalkSession.lastTurn(priorTurns),
    priorTurns,
    debts: atlas.debts,
    packet,
    sessionComparison: talkSessions.sessionComparison(sessionKey),
  });
  let presented;
  if (follow.status === 'ambiguous') {
    presented = follow.nature === 'comparison'
      ? TalkPresentation.presentHypotheticalComparison({ status: 'unavailable' }, packet)
      : follow.nature === 'hypothetical'
        ? TalkPresentation.presentHypotheticalExtra({ status: 'unavailable' }, packet)
        : TalkPresentation.presentVerifiedClaims({ status: 'unavailable', claims: [] }, packet);
    presented.sessionTurn = { kind: 'unavailable' };
  } else if (follow.status === 'resolved-hypothetical') {
    phase('running-forecast');
    const result = TalkHypothetical.evaluateResolved({
      amount: follow.amount,
      debtId: follow.debtId,
      plan: atlas.plan,
      debts: atlas.debts,
      packet,
    });
    presented = TalkPresentation.presentHypotheticalExtra(result, packet);
    presented.sessionTurn = TalkSession.sessionTurnFromHypothetical(result, presented);
  } else if (follow.status === 'resolved-comparison'
      || follow.status === 'resolved-preference') {
    phase('running-forecast');
    const result = TalkHypothetical.evaluateComparisonResolved({
      scenarios: follow.scenarios,
      plan: atlas.plan,
      debts: atlas.debts,
      packet,
    });
    const preference = follow.status === 'resolved-preference'
      || TalkHypothetical.questionAsksAuthorizedPreference(parsed.question)
      ? TalkHypothetical.judgeComparisonPreference(result)
      : null;
    presented = TalkPresentation.presentHypotheticalComparison(result, packet, preference);
    presented.sessionTurn = TalkSession.sessionTurnFromComparison(result, presented);
  } else if (follow.status === 'resolved-reference') {
    if (follow.referentKey === TalkSession.REMAINING_BILLS_INTENT) {
      presented = TalkPresentation.presentPaydayRemainingBills(follow, packet);
      presented.sessionTurn = presented && presented.trust !== 'unavailable'
        ? TalkSession.sessionTurnFromRemainingBills(follow)
        : { kind: 'unavailable' };
    } else {
      const claims = TalkWhy.publishablePaths(follow.paths, packet);
      presented = TalkPresentation.presentVerifiedClaims(
        claims.length ? { status: 'explained', claims } : { status: 'unavailable', claims: [] },
        packet
      );
      presented.sessionTurn = claims.length
        ? TalkWhy.sessionTurnFromExplained(claims)
        : { kind: 'unavailable' };
    }
  } else if (TalkWhy.questionAsksWhy(parsed.question)) {
    const why = TalkWhy.resolve({
      question: parsed.question,
      packet,
      priorTurn: TalkSession.lastTurn(priorTurns),
    });
    // Determined local results only: ready, planner-act, missing last
    // referent, no published risk, missing packet, or stale baseline.
    // A why-ask whose referent is not yet selected reaches Gemini extract.
    if (why.status === 'ready' || why.reason === 'planner-act'
        || why.reason === 'no-referent' || why.reason === 'no-risk'
        || why.reason === 'missing packet' || why.reason === 'stale-baseline') {
      presented = TalkPresentation.presentWhyExplanation(why, packet);
      presented.sessionTurn = TalkWhy.sessionTurnFromWhy(why);
    } else {
      presented = await TalkGemini.ask({
        question: parsed.question,
        packet,
        env: process.env,
        atlas,
        conversation: talkSessions.publicConversation(priorTurns),
        priorTurn: TalkSession.lastTurn(priorTurns),
        priorTurns,
      });
    }
  } else {
    presented = await TalkGemini.ask({
      question: parsed.question,
      packet,
      env: process.env,
      atlas,
      conversation: talkSessions.publicConversation(priorTurns),
      priorTurn: TalkSession.lastTurn(priorTurns),
      priorTurns,
    });
  }
  if (!presented || typeof presented.answer !== 'string' || !presented.answer.trim()) {
    return { error: 'talk answer unavailable' };
  }
  phase('preparing-verified-answer');
  return { presented };
}

function finishTalkAskJson(res, presented, sessionKey, question) {
  const body = TalkStream.publicAskBody(presented);
  if (!body) return res.status(502).json({ error: 'talk answer unavailable' });
  appendTalkSessionTurn(sessionKey, question, presented);
  return res.json(body);
}

function finishTalkAskError(res, stream, err) {
  if (err && err.code === 'TALK_UNAVAILABLE') {
    if (stream) {
      TalkStream.writeError(res, 'talk unavailable');
      TalkStream.endStream(res);
      return;
    }
    return res.status(503).json({ error: 'talk unavailable' });
  }
  if (err && err.code === 'TALK_MALFORMED') {
    const message = err.message === 'question too long' ? 'question too long' : 'malformed request';
    if (stream) {
      TalkStream.writeError(res, message);
      TalkStream.endStream(res);
      return;
    }
    return res.status(400).json({ error: err.message || 'malformed request' });
  }
  console.error('talk ask failed');
  if (stream) {
    TalkStream.writeError(res, 'talk answer unavailable');
    TalkStream.endStream(res);
    return;
  }
  return res.status(502).json({ error: 'talk answer unavailable' });
}

app.post('/talk/ask', (req, res, next) => {
  talkAskJson(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'malformed request' });
    return next();
  });
}, async (req, res) => {
  const stream = TalkStream.wantsStream(req);
  try {
    if (!TalkGemini.isConfigured(process.env)) {
      return res.status(503).json({ error: 'talk unavailable' });
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'malformed request' });
    }
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== 'question') {
      return res.status(400).json({ error: 'malformed request' });
    }
    const parsed = TalkGemini.normalizeQuestion(body.question);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }
    const token = readCookie(req, 'hfd_session');
    const sessionKey = talkSessions.keyFromToken(token);
    if (stream) {
      const gate = TalkStream.createAbortGate(req, res);
      TalkStream.beginStream(res);
      const onPhase = (name) => {
        if (!gate.closed) TalkStream.writeStatus(res, name);
      };
      const outcome = await presentTalkAskTurn(parsed, sessionKey, onPhase, req, res);
      if (gate.closed) {
        TalkStream.endStream(res);
        return;
      }
      if (outcome.error || !outcome.presented) {
        TalkStream.writeError(res, 'talk answer unavailable');
        TalkStream.endStream(res);
        return;
      }
      const write = TalkStream.writeResult(res, outcome.presented);
      if (write.accepted) {
        appendTalkSessionTurn(sessionKey, parsed.question, outcome.presented);
      }
      TalkStream.endStream(res);
      return;
    }
    const outcome = await presentTalkAskTurn(parsed, sessionKey, null, req, res);
    if (outcome.error || !outcome.presented) {
      return res.status(502).json({ error: 'talk answer unavailable' });
    }
    return finishTalkAskJson(res, outcome.presented, sessionKey, parsed.question);
  } catch (err) {
    return finishTalkAskError(res, stream && res.headersSent, err);
  }
});
app.all('/talk/ask', (_req, res) => {
  res.set('Allow', 'POST');
  return res.status(405).json({ error: 'method not allowed' });
});

// Dated balance snapshots. Assembled at request time from snapshots/*.json
// so that folder remains the history authority. Not Forecast input and not
// a second current-state document.
let cachedHistory = null;
let cachedHistoryAt = 0;
function historyMtime(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).reduce((max, name) => {
    const st = fs.statSync(path.join(dir, name));
    return st.mtimeMs > max ? st.mtimeMs : max;
  }, 0);
}
app.get('/balance-history.json', (_req, res) => {
  try {
    const dir = SnapshotBalances.DEFAULT_OUT;
    const stamp = historyMtime(dir);
    if (!cachedHistory || stamp !== cachedHistoryAt) {
      cachedHistory = SnapshotBalances.loadHistory(dir);
      cachedHistoryAt = stamp;
    }
    res.json(cachedHistory);
  } catch (err) {
    console.error('balance history could not be read:', err.message);
    res.status(500).json({ error: 'history unavailable' });
  }
});

// Bind the label to this HTML response, not a later metadata fetch or GitHub
// main. An open tab keeps its own build identity across a deployment.
const runningBuildSha = Assistant.versionIdentifier(environment).gitSha;
const budgetHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace('Running build unavailable', RunningBuild.label(__dirname, runningBuildSha));
app.get(['/', '/index.html'], (_req, res) => res.type('html').end(budgetHtml));
app.get('/planning.html', (_req, res) => res.redirect('/'));
// The literal route above matches the canonical path, including its plain
// case and trailing-slash forms (Express default matching). It does not
// match the percent-encoded or dot-segment forms, which express.static
// would decode and normalise back onto the same file — so retire those
// here too: decode the path once, collapse duplicate slashes and resolve
// dot segments, and redirect only on an exact canonical match. The
// canonical form also folds the Windows-runtime aliases of the same file
// (Systems Review 5549092124): a backslash acts as a path separator, a
// trailing slash still names the file, and a trailing ::$DATA suffix
// names the file's default NTFS stream — none of those may fall through
// to express.static on that runtime.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let decoded;
  try { decoded = decodeURIComponent(req.path); } catch { return next(); }
  const slashed = decoded.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  let canonical = path.posix.normalize(slashed).toLowerCase();
  // Resolve dot segments first, then fold terminal filename dots/spaces
  // on both sides of the default-stream suffix, including exposed slashes.
  canonical = canonical.replace(/[. \/]+$/, '');
  canonical = canonical.replace(/::\$data$/, '').replace(/[. \/]+$/, '');
  if (canonical === '/planning.html') return res.redirect('/');
  return next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false, lastModified: false, maxAge: 0,
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));

app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));

return app;
}

// Trusted assertion for THIS never-activated release, not durable origin history.
// No later activation may occur until authority outside rollbackable binaries
// (or a permanently separate origin) prevents reissuing this after activation.
function createPreactivationApplication(options = {}) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype
    || Reflect.ownKeys(options).some(key => !['env', 'baseSource'].includes(key))) {
    throw new TypeError('sealed preactivation rejects settlement dependencies');
  }
  return createApplication({ ...options, [PREACTIVATION_BOOT]: true });
}

// ---------------------------------------------------------------------
// B4 recovery composition factories. Pure compositions over an injected
// authorization store: no environment, no provisioning, no wiring of
// their own in this slice — the production composition supplies the
// store and the clock. Both fail closed on any malformed input, unknown
// outcome, or store error.
const RECOVERY_HOUSEHOLD = /^household-[a-f0-9]{32}$/;
const RECOVERY_OPERATION = /^operation-[a-f0-9]{32}$/;
const RECOVERY_GENERATION = /^generation-[a-f0-9]{32}$/;
const RECOVERY_HASH = /^[a-f0-9]{64}$/;
const recoveryRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

// Adapts the controller's issuance call to the authorization store: the
// issuance is durable exactly when the store resolves issued or
// reissued-identical; every other outcome (refused, unknown, or a store
// rejection, which propagates) is a refusal the prepare path surfaces as
// prepare-unavailable with no preview installed.
function createRecoveryEligibilityIssuer(options) {
  if (!recoveryRecord(options) || !options.authorizationStore
    || typeof options.authorizationStore.issueEligibility !== 'function'
    || typeof options.now !== 'function')
    throw new TypeError('recovery eligibility issuer: incomplete composition');
  const { authorizationStore, now } = options;
  return async input => {
    if (!recoveryRecord(input) || !RECOVERY_HOUSEHOLD.test(input.householdId)
      || !RECOVERY_OPERATION.test(input.operationId) || !RECOVERY_GENERATION.test(input.generation)
      || !RECOVERY_HASH.test(input.confirmationDigest) || !RECOVERY_HASH.test(input.secretDigest))
      throw new TypeError('recovery eligibility issuer: invalid issuance input');
    const outcome = await authorizationStore.issueEligibility({ householdId: input.householdId,
      operationId: input.operationId, generation: input.generation,
      confirmationDigest: input.confirmationDigest, secretDigest: input.secretDigest,
      issuedAt: now() });
    if (!recoveryRecord(outcome)
      || (outcome.outcome !== 'issued' && outcome.outcome !== 'reissued-identical'))
      throw new Error('recovery eligibility issuance not durable');
  };
}

// The awaited final authority: ONE fresh authorization-store read
// supplies the eligibility record and both revocation tombstones for the
// exact operation/generation, judged against the retained server-derived
// input and the acquired proof view. Session expiry is judged before AND
// after the read, so an expiry landing during the store wait refuses.
// Nothing is cached and nothing is replayed: every call re-reads. A
// judgement failure returns false; only a store error propagates (the
// seam refuses either way).
function createRecoveryFinalAuthority(options) {
  if (!recoveryRecord(options) || !options.authorizationStore
    || typeof options.authorizationStore.readAuthorizationState !== 'function'
    || typeof options.now !== 'function')
    throw new TypeError('recovery final authority: incomplete composition');
  const { authorizationStore, now } = options;
  const digestEqual = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string'
      || !RECOVERY_HASH.test(a) || !RECOVERY_HASH.test(b)) return false;
    const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  return async (retained, view) => {
    if (!recoveryRecord(retained) || !recoveryRecord(view)
      || !RECOVERY_HOUSEHOLD.test(retained.householdId)
      || !RECOVERY_OPERATION.test(retained.operationId)
      || !RECOVERY_GENERATION.test(retained.generation)
      || !RECOVERY_HASH.test(retained.secretDigest) || !RECOVERY_HASH.test(retained.sidDigest)
      || !Number.isSafeInteger(retained.expiresAt)
      || typeof retained.actorId !== 'string' || retained.actorId.length === 0) return false;
    if (retained.expiresAt <= now()) return false;
    const state = await authorizationStore.readAuthorizationState({
      operationId: retained.operationId, generation: retained.generation,
      sidDigest: retained.sidDigest });
    if (retained.expiresAt <= now()) return false;
    if (!recoveryRecord(state) || state.state !== 'ok') return false;
    if (state.operationRevoked !== false || state.sessionRevoked !== false) return false;
    const eligibility = state.eligibility;
    if (!recoveryRecord(eligibility)) return false;
    // The trusted household comes from the retained composition input;
    // the eligibility record must agree with it, never substitute it.
    if (eligibility.householdId !== retained.householdId
      || eligibility.operationId !== retained.operationId
      || eligibility.generation !== retained.generation) return false;
    if (!digestEqual(eligibility.secretDigest, retained.secretDigest)) return false;
    if (view.status === 'committed') return digestEqual(eligibility.confirmationDigest, view.requestDigest);
    if (view.status === 'not-applied') return digestEqual(eligibility.confirmationDigest, view.confirmationDigest);
    return false;
  };
}

// ATLAS-083: the explicit, inactive-by-default startup consumer. This config is
// supplied by a trusted host, never request JSON or ambient database variables.
// It confers no activation, provisioning, driver/Linux or independent-custody
// qualification. Bootstrap/reconcile remain maintenance-owned OUTSIDE startup:
// neither is on the existing runtime surface, and neither may be invented here.
const COMPOSITION_TRUST = /^(?:PG.*|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|NODE_USE_SYSTEM_CA|SSL_CERT_FILE|SSL_CERT_DIR|OPENSSL_.*)$/i;
function compositionError() {
  const error = new Error('settlement composition unavailable; interrupted outcomes remain unknown');
  error.code = 'SETTLEMENT_COMPOSITION_UNAVAILABLE'; return error;
}
function compositionRecord(value, allowed, required = allowed) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw compositionError();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!Reflect.ownKeys(fields).every(k => typeof k === 'string' && allowed.includes(k)
    && Object.hasOwn(fields[k], 'value')) || !required.every(k => Object.hasOwn(fields,k))) throw compositionError();
  return Object.freeze(Object.fromEntries(Object.entries(fields).map(([k,d]) => [k,d.value])));
}
function compositionConnection(value) {
  // The two factories intentionally have no exported validate-only API. Validate
  // BOTH closed profiles here before either factory can construct a client; each
  // factory still owns its TLS/catalog checks and bounded session lifecycle.
  const o = compositionRecord(value,['Client','config','schema','scope','timeouts'],['Client','config','schema','scope']);
  const c = compositionRecord(o.config,['host','port','database','user','password','ssl']);
  const ssl = compositionRecord(c.ssl,['rejectUnauthorized','servername']);
  if (typeof o.Client !== 'function' || typeof c.host !== 'string' || c.host.length > 253
    || !c.host.includes('.') || require('node:net').isIP(c.host) || c.host.includes('-pooler')
    || !c.host.split('.').every(x => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x))
    || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535
    || !['database','user'].every(k => typeof c[k] === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(c[k]))
    || typeof c.password !== 'string' || !c.password.length || c.password.length > 1024 || c.password.includes('\0')
    || ssl.rejectUnauthorized !== true || ssl.servername !== c.host
    || typeof o.schema !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(o.schema)
    || o.schema.startsWith('pg_') || o.schema === 'information_schema'
    || typeof o.scope !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(o.scope)) throw compositionError();
  try { Reflect.construct(Object,[],o.Client); } catch { throw compositionError(); }
  const maxima = {connect:10000,preflight:10000,query:7000,close:2000};
  const timeouts = o.timeouts === undefined ? {} : compositionRecord(o.timeouts,Object.keys(maxima),[]);
  if (Object.entries(timeouts).some(([k,v]) => !Number.isInteger(v) || v <= 0 || v > maxima[k])) throw compositionError();
  return Object.freeze({...o,config:Object.freeze({...c,ssl}),timeouts});
}
// GAP-2 startup seam (issue #765; Atlas 6479329564, accepted dispatch
// 6480076295). The production host's preliminary recovery owner (P1)
// must read authorization state through THIS composition's own guarded
// read (authStore, inside startServer) — never through a separate
// host-owned authorization connection, which would be a second
// authorization lifetime outside this owner's observe / checkReady /
// retire / close ownership. The seam is a stable read-only facade
// keyed by the exact authorization profile object the host hands to
// startServer: the host creates the facade before composing, the
// composition binds it to the guarded read once the phase is ready,
// and retirement unbinds it before any close begins. The facade
// exposes readAuthorizationState only: no raw client or store escapes,
// no result is cached, no grant is minted here, and the final
// authority's store is never substituted. Unbound calls — before
// binding and after retirement — refuse at once, without touching the
// composition. The seam implements no reconnect; the owner/generation
// contract (6475054955) still governs recovery. Controller, preview
// and unknown-write state are the runtime's own and are untouched.
const authorizationReadFacades = new WeakMap();
function createSettlementAuthorizationReadFacade(authorizationProfile) {
  if (!authorizationProfile || typeof authorizationProfile !== 'object'
    || authorizationReadFacades.has(authorizationProfile)) throw compositionError();
  const cell = { bound: null };
  authorizationReadFacades.set(authorizationProfile, cell);
  return Object.freeze({
    readAuthorizationState: async input => {
      const bound = cell.bound;
      if (!bound) throw compositionError();
      return bound(input);
    },
  });
}
async function startServer(options = {}) {
  const o = compositionRecord(options,['env','host','port','baseSource','settlement'],[]);
  const environment = o.settlement === undefined ? o.env || process.env
    : compositionRecord(o.env,Object.keys(o.env || {}));
  if (o.settlement !== undefined && Object.values(environment).some(v => typeof v !== 'string')) throw compositionError();
  const port = o.port ?? environment.PORT ?? 3000;
  if (!(Number.isInteger(port) && port >= 0 && port <= 65535
    || typeof port === 'string' && /^\d{1,5}$/.test(port) && Number(port) <= 65535)
    || o.host !== undefined && (typeof o.host !== 'string' || !o.host.length)) throw compositionError();
  let phase = o.settlement === undefined ? 'inactive' : 'configuring';
  let runtime = null, authorization = null, authOpening = null, authFailure = null;
  let retirement = null, closing = null, reports = null, server = null, app;
  let recover = null, highWater = 0, previousContext = null, facadeCell = null, facadeBound = false;
  const seenClients = new WeakSet();
  const notOpened = () => Object.freeze({state:'retired',close:'not-opened',primary:null,closeDiagnostic:null});
  function retire() {
    if (retirement) return retirement;
    phase = 'retiring'; // Fence synchronously before any close or callback.
    // GAP-2: the facade refuses from the fence — but only the
    // composition that BOUND it may unbind it. A failed duplicate
    // startServer over the same record retires its own attempt; its
    // cleanup must not unbind the live composition's facade.
    if (facadeCell && facadeBound) { facadeCell.bound = null; facadeBound = false; }
    retirement = Promise.resolve().then(async () => {
      const financial = runtime ? runtime.retire() : Promise.resolve(notOpened());
      // The authorization factory owns any in-progress allocation and returns
      // its own close proof on failure. Never race it with another close.
      if (authOpening) { try { await authOpening; } catch { /* captured below */ } }
      const auth = authorization ? authorization.retire() : Promise.resolve(authFailure || notOpened());
      const [f,a] = await Promise.all([financial,auth]);
      reports = Object.freeze({financial:f,authorization:a});
      phase = [f,a].every(r => r.state === 'retired') ? 'retired' : 'lost';
      return reports;
    });
    return retirement;
  }
  function checkReady() {
    if (phase !== 'ready' || runtime.status().state !== 'ready' || authorization.status().state !== 'ready') {
      void retire(); throw compositionError();
    }
  }
  function observe(Client) {
    // Observe loss only; no client/session/query escapes either existing owner.
    return class ObservedClient {
      constructor(config) {
        const raw = new Client(config);
        if (!raw || seenClients.has(raw)) throw compositionError();
        seenClients.add(raw);
        if (typeof raw.on === 'function') {
          raw.on('error', () => { void retire(); });
          raw.on('end', () => { void retire(); });
        }
        return raw;
      }
    };
  }
  function close() {
    if (closing) return closing;
    const retired = retire();
    const stopped = new Promise(resolve => {
      if (!server?.listening) return resolve();
      server.close(resolve); server.closeIdleConnections();
    });
    closing = Promise.all([retired,stopped]).then(([result]) => result);
    return closing;
  }
  try {
    if (o.settlement === undefined) {
      app = createPreactivationApplication({env:environment,...(o.baseSource ? {baseSource:o.baseSource} : {})});
    } else {
      if (o.baseSource !== undefined || o.env === undefined
        || Object.keys(process.env).some(k => COMPOSITION_TRUST.test(k))) throw compositionError();
      const s = compositionRecord(o.settlement,['connection','authorization','custody','application']);
      facadeCell = authorizationReadFacades.get(s.authorization) || null;
      const financial = compositionConnection(s.connection), auth = compositionConnection(s.authorization);
      if (financial.config.host === auth.config.host && financial.config.database === auth.config.database
        && (financial.config.user === auth.config.user || financial.schema === auth.schema)) throw compositionError();
      const a = compositionRecord(s.application,['householdId','origin','authorize','authorizeRecovery','contextReader','now']);
      if (!RECOVERY_HOUSEHOLD.test(a.householdId) || ['authorize','authorizeRecovery','contextReader','now']
        .some(k => typeof a[k] !== 'function') || require('node:util').types.isAsyncFunction(a.authorize)) throw compositionError();
      const custody = compositionRecord(s.custody,['pinStore','backupStore','terminalHistory','exclusionDomain']);
      function context() {
        try {
        if (!['configuring','opening','ready'].includes(phase)) throw compositionError();
        const c = compositionRecord(a.contextReader(),['canonical','env','domain','contextRevision']);
        if (!c.canonical || Object.getPrototypeOf(c.canonical) !== Object.prototype
          || !c.env || Object.getPrototypeOf(c.env) !== Object.prototype
          || typeof c.domain !== 'string' || !c.domain.length || c.domain.length > 128
          || !Number.isSafeInteger(c.contextRevision) || c.contextRevision <= 0 || c.contextRevision < highWater)
          throw compositionError();
        const e = compositionRecord(c.env,Object.keys(c.env));
        if (Object.values(e).some(v => typeof v !== 'string')
          || e.SITE_PASSWORD !== environment.SITE_PASSWORD || e.SESSION_SECRET !== environment.SESSION_SECRET) throw compositionError();
        const captured = Object.freeze({...c,canonical:structuredClone(c.canonical),env:e});
        // Content equality is an extra misuse check, never a replacement for
        // the authority's revision. Unobserved ABA requires that trusted owner
        // to advance its revision; startup cannot manufacture rollback proof.
        if (previousContext && c.contextRevision === highWater
          && !require('node:util').isDeepStrictEqual(captured,previousContext)) throw compositionError();
        highWater = c.contextRevision; previousContext = captured; return captured;
        } catch { void retire(); throw compositionError(); }
      }
      context(); // Validate the full initial reader before either client.
      const sameContext = (before,after) => before.domain === after.domain && before.contextRevision === after.contextRevision;
      const now = () => { try {const tick=a.now();if(!Number.isSafeInteger(tick)||tick<=0)throw compositionError();return tick;}
        catch {void retire();throw compositionError();} };
      now();
      function authorize(input) {
        checkReady(); const before=context(), value=a.authorize(Object.freeze({...input}));
        // Ordinary household policy MUST be synchronous: the final SQL
        // authority rechecks it without adding another awaited authority.
        if (require('node:util').types.isPromise(value)) {
          Reflect.apply(Promise.prototype.then,value,[() => {},() => {}]); throw compositionError();
        }
        const result=compositionRecord(value,['householdId','actorId']);
        checkReady();
        if (result.householdId !== a.householdId || result.actorId !== input.actorId
          || !sameContext(before,context())) throw compositionError();
        return result;
      }
      const authStore = Object.freeze(Object.fromEntries(['issueEligibility','readAuthorizationState','appendSessionRevocation']
        .map(name => [name, async (...args) => {
          checkReady(); const value=await authorization.authorizationStore[name](...args);checkReady();return value;
        }])));
      const final = createRecoveryFinalAuthority({authorizationStore:authStore,now});
      const guardedCustody = (source,names) => Object.freeze(Object.fromEntries(names.map(name => {
        const methods=compositionRecord(source,names);
        if (typeof methods[name] !== 'function') throw compositionError();
        const method=methods[name].bind(source);
        return [name,async(...args) => {try {checkReady();const value=await method(...args);checkReady();return value;}
          catch {void retire();throw compositionError();}}];
      })));
      const nativeHistory = custody.terminalHistory && Object.hasOwn(custody.terminalHistory,'mode');
      const history = nativeHistory ? compositionRecord(custody.terminalHistory,['mode'])
        : guardedCustody(custody.terminalHistory,['readSnapshot','compareAndAppend']);
      // Keep the registry's visibility of the ACTUAL injected pin surface;
      // observation wrappers must not hide aliases under another domain.
      require('./scripts/settlement-evidence-terminal-certificate')
        .registerDomain(a.householdId,custody.exclusionDomain,true,[custody.pinStore]);
      // Constructing the real runtime validates store/domain/history rules with
      // no I/O. Readiness below means session/catalog readiness ONLY.
      runtime = require('./scripts/settlement-evidence-postgres-runtime').createSettlementEvidencePostgresRuntime({
        connection:{...financial,Client:observe(financial.Client)},
        custody:{pinStore:guardedCustody(custody.pinStore,['read','advance']),
          backupStore:guardedCustody(custody.backupStore,['put','get','list']),
          terminalHistory:history,exclusionDomain:custody.exclusionDomain},
        application:{householdId:a.householdId,origin:a.origin,authorize,now,
          contextReader:() => {checkReady();const c=context();return Object.freeze({domain:c.domain,contextRevision:c.contextRevision});},
          acquire:async() => {
            try {
            checkReady();const before=context();
            const paired=await ServerLiveRefresh.acquireSettlementWithWitness(before.canonical,before.env,{contextReader:context});
            checkReady();if(!sameContext(before,context()))throw compositionError();
            return {...paired.acquisition,witness:paired.witness};
            } catch {void retire();throw compositionError();}
          },
          readBase:async() => {try {checkReady();const before=context();const base=await ServerLiveRefresh.serve(before.canonical,before.env);
            checkReady();if(!sameContext(before,context()))throw compositionError();return base;}
            catch {void retire();throw compositionError();}}
        },
        recovery:{recoveryRead:true,issueRecoveryEligibility:createRecoveryEligibilityIssuer({authorizationStore:authStore,now}),
          authorizeRecovery:async input => {authorize({actorId:input.actorId});const before=context();
            const grant=await a.authorizeRecovery(input);authorize({actorId:input.actorId});
            if(!sameContext(before,context()))throw compositionError();return grant;},
          authorizeRecoveryFinal:async(retained,view) => {
            authorize({actorId:retained.actorId});const before=context();
            const admitted=await final(retained,view);
            // No await after the final snapshot: ordinary policy, household,
            // runtime and context checks are synchronous. The HTTP seam then
            // revalidates its private signed identity/expiry before serializing.
            authorize({actorId:retained.actorId});
            return admitted === true && retained.householdId === a.householdId && sameContext(before,context());
          }}
      });
      // Exactly one application/controller lifetime. M2: retain the PRIVATE
      // settled-uncertainty capability, never reset/recreate its controller or
      // discard a latch/marker/journal at startup. No public maintenance route.
      app = createApplication({env:environment,baseSource:runtime.settlement.readBase,
        settlement:{...runtime.settlement,registerRecovery:fn => {recover=fn;}},
        [SESSION_REVOCATION]:async sidDigest => {
          try {
            const result=await authStore.appendSessionRevocation({sidDigest,revokedAt:now()});
            if (!['appended','already-present'].includes(result?.outcome)) throw compositionError();
          } catch {void retire();throw compositionError();}
        }});
      phase='opening';await runtime.connect();
      if(phase!=='opening')throw compositionError();
      authOpening=require('./scripts/settlement-evidence-authorization-connection')
        .createSettlementEvidenceAuthorizationConnection({...auth,Client:observe(auth.Client)})
        .then(owner => {authorization=owner;return owner;},error => {
          authFailure=error.retirement || Object.freeze({state:'lost',close:'unconfirmed',primary:null,closeDiagnostic:null});
          throw compositionError();
        });
      await authOpening;if(phase!=='opening')throw compositionError();phase='ready';checkReady();
      // GAP-2: bind the host's read facade to this composition's own
      // guarded authorization read — after readiness, before listen,
      // so no request can observe an unbound or half-bound facade. A
      // facade already bound to a live composition refuses the bind
      // (and with it this composition) rather than being shared.
      if (facadeCell) {
        if (facadeCell.bound) throw compositionError();
        facadeCell.bound = input => authStore.readAuthorizationState(input);
        facadeBound = true;
      }
    }
    await new Promise((resolve,reject) => {
      server=app.listen({port:Number(port),...(o.host ? {host:o.host} : {})},resolve);
      server.once('error',reject);
    });
    if(o.settlement!==undefined)checkReady();
    return Object.freeze({app,server,close,status:() => Object.freeze({state:phase,
      ...(runtime ? {financial:runtime.status(),authorization:authorization?.status() || null} : {})}),
      recoverSettledUncertainty:async() => {checkReady();return recover ? recover() : Object.freeze({status:'blocked'});}});
  } catch {
    const error=compositionError();error.retirement=await close();throw error;
  }
}

// Entry shutdown coordination (used by the require.main signal
// handler below): both refusal fences fire synchronously — the
// composition's retire fence via owner.close(), and GAP-1's
// synchronous retired fence inside the host's retireCustody() — and
// the bounded custody retirement runs CONCURRENTLY with the HTTP
// drain, never chained behind it. A request stalled inside a custody
// operation can hold server.close's drain open, and that request is
// exactly what custody retirement must not wait for: custody
// operational calls are bounded at the host's session wrapper, so
// the stalled request fails as an unknown outcome (never replayed)
// and the drain can finish — but the terminal custody receipt is
// produced on retireCustody()'s own bound either way.
function initiateCompositionShutdown(owner, host) {
  const custodyReport = host.retireCustody();
  const drained = Promise.resolve(owner.close()).then(() => null, () => null);
  return Object.freeze({ custodyReport, drained });
}

module.exports = { createApplication, createPreactivationApplication,
  createRecoveryEligibilityIssuer, createRecoveryFinalAuthority, startServer,
  createSettlementAuthorizationReadFacade, initiateCompositionShutdown };
if (require.main === module) {
  // Production composition root (Plan #5 assembly): the host wires the
  // settlement composition from process.env values only. Inactive (no
  // settlement values) → startServer() exactly as before. A partial or
  // malformed settlement configuration throws the host's named error
  // here, before anything listens — a boot failure, never a degraded
  // composition. The host's canonical context adapter starts only once
  // the composed server is up, and closes with it.
  const host = require('./scripts/settlement-production-host')
    .createSettlementProductionHost(process.env);
  const starting = (async () => {
    // Assembly-owned custody discipline (PR #772 contracts): when a
    // custody profile is configured, prepare() opens the host's
    // custody construction gate before the composition exists; the
    // retained custody session is then qualified inside its own
    // connect, before any application query — a session that fails
    // qualification never serves one, and the composition fails
    // closed on the first custody operation.
    await host.prepare();
    return host.active
      ? startServer({ env: process.env, settlement: host.settlement })
      : startServer();
  })();
  starting.then(owner => {
    host.startContextAdapter();
    console.log(`Household finance dashboard listening on ${owner.server.address().port}`);
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal,() => {
      // The composition root owns confirmed custody closure: GAP-1's
      // retire() is local fencing only, so the host's retireCustody()
      // report is the closure receipt — a failed or unconfirmed close
      // is surfaced, never silently assumed. The shutdown sequence
      // runs that retirement concurrently with the HTTP drain (see
      // initiateCompositionShutdown): it never waits for a request
      // that needs the retirement to finish.
      const { custodyReport } = initiateCompositionShutdown(owner, host);
      void custodyReport.then(report => {
        host.close();
        if (report && report.close !== 'confirmed' && report.close !== 'not-started') {
          console.error(`FATAL: custody connection closure ${report.close}.`);
          process.exitCode = 1;
        }
      }, () => host.close());
    });
  }).catch(() => {host.close();console.error('FATAL: server startup unavailable.');process.exitCode=1;});
}
