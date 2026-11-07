'use strict';
/* Talk safe streaming — allowlisted progress, then the verified payload.
 *
 * Proves POST /talk/ask with Accept: text/event-stream never publishes
 * unverified Gemini prose, that the final result event equals the
 * non-stream JSON body for the same question on an isolated session,
 * that validation failure emits no financial result, that cancel leaves
 * the UI without partial figures, and that session/auth isolation is
 * unchanged. Mocked Gemini only.
 * `node test/test-talk-stream.js`
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const vm = require('vm');
const { spawn } = require('child_process');
const TalkStream = require('../scripts/talk-stream.js');
const TalkSession = require('../scripts/talk-session.js');
const TalkGemini = require('../scripts/talk-gemini.js');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');
const FORECAST = path.join(ROOT, 'public', 'forecast.js');
const POSITIONS = path.join(ROOT, 'docs', 'positions.csv');
const SNAPSHOT_DIR = path.join(ROOT, 'snapshots');
const PASS = 'synthetic-site-password';
const SECRET = 'synthetic-session-secret';
const ASSISTANT_TOKEN = 'synthetic-assistant-token-32chars!!';
const GEMINI_KEY = 'synthetic-talk-gemini-key-32chars!!';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const liveHash = hashFile(DATA);
const forecastHash = hashFile(FORECAST);
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
  ok(hashFile(FORECAST) === forecastHash, `${label}: public/forecast.js bytes unchanged`);
  if (positionsHash) {
    ok(hashFile(POSITIONS) === positionsHash, `${label}: positions.csv bytes unchanged`);
  }
  const now = snapshotState();
  ok(now.length === snapshotHashes.length
    && now.every((row, i) => row === snapshotHashes[i]),
    `${label}: snapshots unchanged`);
}

function forbiddenBlob(value) {
  const text = JSON.stringify(value == null ? {} : value);
  return /"providerAccountId"\s*:/.test(text)
    || /"providerTransactionId"\s*:/.test(text)
    || /Bearer\s+\S+/.test(text)
    || /LUNCHMONEY_ACCESS_TOKEN/.test(text)
    || /SITE_PASSWORD/.test(text)
    || /SESSION_SECRET/.test(text)
    || /ATLAS_ASSISTANT_TOKEN/.test(text)
    || /ATLAS_TALK_GEMINI_API_KEY/.test(text)
    || /synthetic-site-password/.test(text)
    || /synthetic-session-secret/.test(text)
    || /synthetic-assistant-token/.test(text)
    || /synthetic-talk-gemini-key/.test(text);
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
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
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

async function login(base, password) {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(password || PASS)}`,
  });
  const setCookie = res.headers.get('set-cookie') || '';
  return { status: res.status, cookie: setCookie.split(';')[0], setCookie };
}

function geminiOkBody(text) {
  return JSON.stringify({
    candidates: [{
      content: { parts: [{ text }], role: 'model' },
      finishReason: 'STOP',
    }],
  });
}

const DEFAULT_EXTRACTED = JSON.stringify({
  status: 'explained',
  claims: [{ path: 'authority.planner', equals: 'Forecast' }],
});
const LEAKED_PROSE = 'Your leftover is $400 and you should put $2,000 on Visa this payday.';
const INCOMPLETE_JSON = '{"status":"explained","claims":[{"path":"leftover","equals":';

function startMockGemini(replies, options) {
  const captured = [];
  const queue = Array.isArray(replies) ? replies.slice() : [];
  const defaultText = DEFAULT_EXTRACTED;
  const delayMs = options && options.delayMs ? Number(options.delayMs) : 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      captured.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        raw,
        body: (() => { try { return JSON.parse(raw); } catch { return null; } })(),
      });
      const next = queue.length > 0 ? queue.shift() : defaultText;
      const reply = () => {
        res.setHeader('content-type', 'application/json');
        res.end(geminiOkBody(typeof next === 'string' ? next : defaultText));
      };
      if (delayMs > 0) setTimeout(reply, delayMs);
      else reply();
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        captured,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
    server.on('error', reject);
  });
}

function parseSse(text) {
  const events = [];
  const blocks = String(text || '').split('\n\n');
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (!line || line.charAt(0) === ':') continue;
      if (line.indexOf('event:') === 0) event = line.slice(6).trim();
      else if (line.indexOf('data:') === 0) {
        const payload = line.slice(5);
        dataLines.push(payload.charAt(0) === ' ' ? payload.slice(1) : payload);
      }
    }
    if (!dataLines.length) continue;
    events.push({ event, data: dataLines.join('\n') });
  }
  return events;
}

async function readResponseText(res) {
  return res.text();
}

function askHeaders(cookie, extra) {
  return Object.assign({
    cookie,
    'content-type': 'application/json',
  }, extra || {});
}

function askJson(base, cookie, question) {
  return fetch(`${base}/talk/ask`, {
    method: 'POST',
    headers: askHeaders(cookie),
    body: JSON.stringify({ question }),
  });
}

function askStream(base, cookie, question, extra) {
  return fetch(`${base}/talk/ask`, {
    method: 'POST',
    headers: askHeaders(cookie, Object.assign({ accept: 'text/event-stream' }, extra || {})),
    body: JSON.stringify({ question }),
    signal: extra && extra.signal,
  });
}

function eventHasLeak(events, needles) {
  const blob = events.map(ev => `${ev.event}\n${ev.data}`).join('\n');
  return needles.some(needle => blob.indexOf(needle) !== -1);
}

function resultBodies(events) {
  return events.filter(ev => ev.event === 'result').map(ev => {
    try { return JSON.parse(ev.data); } catch { return null; }
  });
}

function loadTalkStreamApi() {
  const src = read('public/talk.js');
  const loadingP = { textContent: 'Atlas is reading the current picture…' };
  const loading = {
    parentNode: { removeChild() { loading.removed = true; } },
    removed: false,
    querySelector(sel) { return sel === 'p' ? loadingP : null; },
  };
  const created = [];
  const sandbox = {
    App: { boot() {} },
    AbortController,
    TextDecoder,
    document: {
      querySelector(sel) {
        if (sel === '[data-talk-role="atlas-loading"]') {
          return loading.removed ? null : loading;
        }
        return null;
      },
      createElement(tag) {
        const el = {
          tagName: tag,
          className: '',
          children: [],
          textContent: '',
          attrs: {},
          setAttribute(k, v) { this.attrs[k] = v; },
          getAttribute(k) { return this.attrs[k]; },
          appendChild(child) {
            this.children.push(child);
            return child;
          },
        };
        created.push(el);
        return el;
      },
    },
    fetch() { return Promise.resolve({ ok: false, json: async () => ({}) }); },
    $(id) {
      if (id === 'talk-send') return { disabled: true, setAttribute() {} };
      if (id === 'talk-input') return { value: '', setAttribute() {} };
      if (id === 'talk-seam') return { textContent: '' };
      if (id === 'talk-context') return { textContent: '', dataset: {} };
      if (id === 'talk-thread') return { insertAdjacentHTML() {}, appendChild() {} };
      if (id === 'talk-empty') return { hidden: false };
      if (id === 'talk-composer' || id === 'talk-prompts') return { addEventListener() {} };
      return null;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    src + '\nthis.__api = { TALK_STREAM_PHASES, talkStreamStatusText, parseTalkSse, interpretTalkStreamEvent, applyTalkStreamEvents, talkAnswerNode, talkPresentation };',
    sandbox
  );
  return { api: sandbox.__api, loading, loadingP, created };
}

console.log('=== 1. Stream contract is allowlisted status, then verified payload ===');
{
  const streamSrc = read('scripts/talk-stream.js');
  const serverSrc = read('server.js');
  const talkSrc = stripComments(read('public/talk.js'));
  ok(TalkStream.PHASES.understanding
      && TalkStream.PHASES['checking-atlas-context']
      && TalkStream.PHASES['running-forecast']
      && TalkStream.PHASES['preparing-verified-answer']
      && Object.keys(TalkStream.PHASES).length === 4,
    'server allowlists exactly four progress phases');
  ok(!/generateContent|extractAnswerText|candidates/.test(streamSrc)
      && !/require\(['"][^'"]*talk-gemini/.test(streamSrc)
      && !/require\(['"][^'"]*forecast/i.test(streamSrc),
    'talk-stream.js does not call Gemini or Forecast');
  ok(TalkStream.encodeEvent('status', { phase: 'understanding', message: LEAKED_PROSE }) === ''
      && TalkStream.encodeEvent('status', { phase: 'invented' }) === ''
      && TalkStream.encodeEvent('token', { text: LEAKED_PROSE }) === ''
      && TalkStream.encodeEvent('result', { answer: '', leftover: 400 }) === ''
      && TalkStream.encodeEvent('result', { answer: 'ok', sessionTurn: { amount: 400 } }).indexOf('sessionTurn') === -1
      && TalkStream.encodeEvent('error', { error: 'talk answer unavailable', answer: LEAKED_PROSE }) === '',
    'encoder rejects extra keys, unknown events, and empty financial payloads');
  ok(TalkStream.wantsStream({ headers: { accept: 'text/event-stream' } }) === true
      && TalkStream.wantsStream({ headers: { accept: '*/*' } }) === false
      && TalkStream.wantsStream({ headers: { accept: 'application/json' } }) === false,
    'stream is opt-in via an explicit text/event-stream Accept token');
  ok(/TalkStream\.wantsStream/.test(serverSrc)
      && /presentTalkAskTurn/.test(serverSrc)
      && /TalkGemini\.ask/.test(serverSrc)
      && /publicAskBody/.test(serverSrc)
      && /const write = TalkStream\.writeResult\(res, outcome\.presented\)/.test(serverSrc)
      && /if \(write\.accepted\)/.test(serverSrc)
      && /appendTalkSessionTurn\(sessionKey, parsed\.question, outcome\.presented\)/.test(serverSrc)
      && !/if \(wrote && !gate\.closed\)/.test(serverSrc)
      && !/return wrote !== false/.test(streamSrc),
    'JSON and stream paths share one present-and-publish turn; stream appends on write.accepted');
  ok(/accept:\s*'text\/event-stream'/.test(talkSrc)
      && /JSON\.stringify\(\{ question \}\)/.test(talkSrc)
      && !/conversation|history|priorTurns/.test(talkSrc),
    'browser still POSTs { question } only and asks for SSE');
  ok(!/EventSource|WebSocket|XMLHttpRequest/.test(talkSrc)
      && !/money2\(|\bmoney\(/.test(talkSrc)
      && !/Forecast\./.test(talkSrc),
    'talk.js still does not open another transport or calculate');
  const api = loadTalkStreamApi().api;
  ok(Object.keys(api.TALK_STREAM_PHASES).sort().join(',')
      === Object.keys(TalkStream.PHASES).sort().join(','),
    'browser phase allowlist matches the server');
  const leakedStatus = api.interpretTalkStreamEvent({
    event: 'status',
    data: JSON.stringify({ phase: 'understanding', message: LEAKED_PROSE }),
  });
  ok(leakedStatus.type === 'status'
      && leakedStatus.text === api.TALK_STREAM_PHASES.understanding
      && leakedStatus.text.indexOf(LEAKED_PROSE) === -1,
    'browser status copy comes from the local allowlist, not event data extras');
  const leakedToken = api.interpretTalkStreamEvent({
    event: 'token',
    data: JSON.stringify({ text: LEAKED_PROSE }),
  });
  const incomplete = api.interpretTalkStreamEvent({
    event: 'result',
    data: INCOMPLETE_JSON,
  });
  const ignoredMessage = api.interpretTalkStreamEvent({
    event: 'message',
    data: LEAKED_PROSE,
  });
  ok(leakedToken.type === 'ignore'
      && incomplete.type === 'ignore'
      && ignoredMessage.type === 'ignore',
    'browser ignores token events, incomplete JSON, and raw message events');
}

console.log('\n=== 1b. res.write() === false is accepted; session turn is retained ===');
{
  const presented = {
    answer: 'Forecast remains the planner.',
    source: 'packet',
    trust: 'calculated',
    asOf: '2026-09-15',
    freshness: 'current',
    action: null,
    cards: null,
    citations: [{ label: 'Forecast', href: '#forecast' }],
    sessionTurn: { kind: 'explained' },
  };
  const question = 'What should I know today?';

  function mockRes(writeReturn, extras) {
    return Object.assign({
      writableEnded: false,
      destroyed: false,
      chunks: [],
      write(chunk) {
        this.chunks.push(chunk);
        return writeReturn;
      },
      flush() { this.flushed = true; },
      end() { this.writableEnded = true; },
    }, extras || {});
  }

  function retainIfAccepted(write, sessions, key) {
    if (write.accepted) {
      sessions.append(key, {
        question,
        presented: presented.answer,
        kind: presented.sessionTurn.kind,
      });
    }
  }

  const backpressure = mockRes(false);
  const write = TalkStream.writeResult(backpressure, presented);
  ok(write && write.accepted === true && write.backpressure === true,
    'res.write() === false is accepted backpressure, not a failed write');
  ok(backpressure.chunks.length === 1
      && backpressure.chunks[0].indexOf('event: result') === 0
      && backpressure.chunks[0].indexOf(presented.answer) !== -1
      && backpressure.chunks[0].indexOf('sessionTurn') === -1,
    'backpressure still queues the verified public result');

  const sessions = TalkSession.createSessionContext({ secret: SECRET });
  retainIfAccepted(write, sessions, 'session-a');
  TalkStream.endStream(backpressure);
  const turns = sessions.turns('session-a');
  ok(turns.length === 1
      && turns[0].question === question
      && turns[0].presented === presented.answer
      && turns[0].kind === 'explained'
      && backpressure.writableEnded === true,
    'accepted backpressure retains the session turn before the response ends');

  const dead = mockRes(true, { destroyed: true });
  const deadWrite = TalkStream.writeResult(dead, presented);
  const deadSessions = TalkSession.createSessionContext({ secret: SECRET });
  retainIfAccepted(deadWrite, deadSessions, 'session-a');
  ok(deadWrite.accepted === false
      && deadWrite.reason === 'undeliverable'
      && dead.chunks.length === 0
      && deadSessions.turns('session-a').length === 0,
    'a destroyed socket is undeliverable and retains no session turn');

  const ended = mockRes(true, { writableEnded: true });
  ok(TalkStream.writeResult(ended, presented).accepted === false
      && ended.chunks.length === 0,
    'an ended response is not accepted');

  const flushed = mockRes(true);
  const okWrite = TalkStream.writeResult(flushed, presented);
  ok(okWrite.accepted === true && okWrite.backpressure === false
      && flushed.chunks.length === 1,
    'res.write() === true is accepted without backpressure');
}

(async () => {
  console.log('\n=== 2. Final stream result equals non-stream JSON ===');
  const equalMock = await startMockGemini();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const atlas = await startAtlas(isolatedEnv({
    SITE_PASSWORD: PASS,
    SESSION_SECRET: SECRET,
    ATLAS_ASSISTANT_TOKEN: ASSISTANT_TOKEN,
    ATLAS_TALK_GEMINI_API_KEY: GEMINI_KEY,
    ATLAS_TALK_GEMINI_BASE_URL: equalMock.url,
    PORT: String(port),
  }));
  try {
    const sessionJson = await login(base);
    const sessionStream = await login(base);
    const question = 'What should I know today?';
    const jsonRes = await askJson(base, sessionJson.cookie, question);
    const jsonBody = await jsonRes.json();
    const streamRes = await askStream(base, sessionStream.cookie, question);
    ok(streamRes.status === 200
        && String(streamRes.headers.get('content-type') || '').indexOf('text/event-stream') !== -1,
      'explicit Accept: text/event-stream starts SSE',
      `status ${streamRes.status} type ${streamRes.headers.get('content-type')}`);
    const streamText = await readResponseText(streamRes);
    const events = parseSse(streamText);
    const phases = events.filter(ev => ev.event === 'status').map(ev => {
      try { return JSON.parse(ev.data).phase; } catch { return null; }
    });
    const results = resultBodies(events);
    ok(jsonRes.status === 200 && typeof jsonBody.answer === 'string' && jsonBody.answer,
      'non-stream ask still returns the verified JSON body');
    ok(phases[0] === 'understanding'
        && phases.indexOf('checking-atlas-context') !== -1
        && phases[phases.length - 1] === 'preparing-verified-answer'
        && phases.indexOf('running-forecast') === -1,
      'explainer stream emits understanding → context → preparing, not Forecast');
    ok(results.length === 1
        && JSON.stringify(results[0]) === JSON.stringify(jsonBody),
      'final stream result equals the non-stream body');
    ok(!('sessionTurn' in jsonBody)
        && !('sessionTurn' in (results[0] || {}))
        && events.every(ev => ev.event === 'status' || ev.event === 'result' || ev.event === 'error'),
      'stream events stay inside the allowlisted names and public body');
    ok(!forbiddenBlob(events) && !forbiddenBlob(jsonBody),
      'neither path leaks secrets or provider ids');
    ok(!/id:/.test(streamText),
      'SSE has no Last-Event-ID resume surface');

    const anon = await askStream(base, '', question);
    const anonBody = await anon.json();
    ok(anon.status === 401 && anonBody.error === 'not authenticated' && !anonBody.answer,
      'anonymous stream ask is still 401 JSON');
    const bearer = await fetch(`${base}/talk/ask`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ASSISTANT_TOKEN}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ question }),
      redirect: 'manual',
    });
    const bearerBody = await bearer.json();
    ok(bearer.status === 401 && bearerBody.error === 'not authenticated' && !bearerBody.answer,
      'assistant Bearer still cannot unlock the stream path');
  } finally {
    await atlas.stop();
    await equalMock.close();
  }
  filesUnchanged('stream equals JSON');

  console.log('\n=== 3. Failed validation publishes no financial stream result ===');
  const leakNeedles = [LEAKED_PROSE, INCOMPLETE_JSON, 'leftover', '$400', '$2,000', 'Visa'];
  async function expectNoFinancialStream(modelText, label) {
    const mock = await startMockGemini([modelText]);
    const p = await freePort();
    const url = `http://127.0.0.1:${p}`;
    const server = await startAtlas(isolatedEnv({
      SITE_PASSWORD: PASS,
      SESSION_SECRET: SECRET,
      ATLAS_TALK_GEMINI_API_KEY: GEMINI_KEY,
      ATLAS_TALK_GEMINI_BASE_URL: mock.url,
      PORT: String(p),
    }));
    try {
      const authed = await login(url);
      const res = await askStream(url, authed.cookie, 'What should I know today?');
      const text = await readResponseText(res);
      const events = parseSse(text);
      const results = resultBodies(events);
      const errors = events.filter(ev => ev.event === 'error');
      ok(res.status === 200 && results.length === 0 && errors.length === 1,
        `${label}: SSE has an error event and no result`,
        `results ${results.length} errors ${errors.length}`);
      ok(!eventHasLeak(events, leakNeedles),
        `${label}: raw Gemini text never appears in any streamed event`);
      const parsedError = (() => { try { return JSON.parse(errors[0].data); } catch { return {}; } })();
      ok(parsedError.error === 'talk answer unavailable' && !('answer' in parsedError),
        `${label}: error event has no financial answer field`);
    } finally {
      await server.stop();
      await mock.close();
    }
  }
  await expectNoFinancialStream(LEAKED_PROSE, 'planner-act prose');
  await expectNoFinancialStream(INCOMPLETE_JSON, 'incomplete model JSON');
  await expectNoFinancialStream(
    JSON.stringify({
      status: 'explained',
      claims: [{ path: 'leftover', equals: 400 }],
      advice: LEAKED_PROSE,
    }),
    'structured claims plus planner-act field'
  );
  filesUnchanged('validation failure stream');

  console.log('\n=== 4. Cancel / disconnect leaves no partial figures ===');
  {
    const mock = await startMockGemini([DEFAULT_EXTRACTED], { delayMs: 2500 });
    const p = await freePort();
    const url = `http://127.0.0.1:${p}`;
    const server = await startAtlas(isolatedEnv({
      SITE_PASSWORD: PASS,
      SESSION_SECRET: SECRET,
      ATLAS_TALK_GEMINI_API_KEY: GEMINI_KEY,
      ATLAS_TALK_GEMINI_BASE_URL: mock.url,
      PORT: String(p),
    }));
    try {
      const authed = await login(url);
      const controller = new AbortController();
      const pending = askStream(url, authed.cookie, 'What should I know today?', {
        signal: controller.signal,
      });
      await new Promise(resolve => setTimeout(resolve, 80));
      controller.abort();
      let aborted = false;
      let received = '';
      try {
        const res = await pending;
        received = await readResponseText(res);
      } catch (err) {
        aborted = !!(err && (err.name === 'AbortError' || /abort/i.test(String(err.message || ''))));
      }
      const events = parseSse(received);
      const results = resultBodies(events);
      ok(aborted || results.length === 0,
        'abort mid-flight yields no result event',
        aborted ? 'fetch aborted' : `events ${events.map(ev => ev.event).join(',')}`);
      ok(!eventHasLeak(events, [LEAKED_PROSE, INCOMPLETE_JSON]),
        'aborted stream still contains no leaked model text');

      const ui = loadTalkStreamApi();
      const partial = [
        { event: 'status', data: JSON.stringify({ phase: 'understanding' }) },
        { event: 'status', data: JSON.stringify({ phase: 'checking-atlas-context' }) },
        { event: 'token', data: JSON.stringify({ text: LEAKED_PROSE }) },
        { event: 'message', data: LEAKED_PROSE },
      ];
      const applied = ui.api.applyTalkStreamEvents(partial, text => {
        ui.loadingP.textContent = text;
      });
      ok(applied.result == null
          && applied.error == null
          && ui.created.length === 0
          && ui.loadingP.textContent === ui.api.TALK_STREAM_PHASES['checking-atlas-context']
          && ui.loadingP.textContent.indexOf('$') === -1,
        'UI cancel path keeps only allowlisted status copy and no answer cards');
    } finally {
      await server.stop();
      await mock.close();
    }
    filesUnchanged('cancel stream');
  }

  console.log('\n=== 5. Stream keeps cards, citations, and multi-turn isolation ===');
  {
    const mock = await startMockGemini();
    const p = await freePort();
    const url = `http://127.0.0.1:${p}`;
    const server = await startAtlas(isolatedEnv({
      SITE_PASSWORD: PASS,
      SESSION_SECRET: SECRET,
      ATLAS_ASSISTANT_TOKEN: ASSISTANT_TOKEN,
      ATLAS_TALK_GEMINI_API_KEY: GEMINI_KEY,
      ATLAS_TALK_GEMINI_BASE_URL: mock.url,
      PORT: String(p),
    }));
    try {
      const sessionA = await login(url);
      const sessionB = await login(url);
      const first = await askStream(url, sessionA.cookie, 'What should I know today?');
      const firstEvents = parseSse(await readResponseText(first));
      const firstBody = resultBodies(firstEvents)[0];
      ok(first.status === 200 && firstBody && firstBody.answer
          && (firstBody.citations == null || Array.isArray(firstBody.citations))
          && (firstBody.cards == null || (firstBody.cards && firstBody.cards.version === 1)),
        'stream result keeps the incumbent public Talk shape');

      const followA = await askJson(url, sessionA.cookie, 'What about $500 instead?');
      const followABody = await followA.json();
      const followB = await askStream(url, sessionB.cookie, 'What about $500 instead?');
      const followBEvents = parseSse(await readResponseText(followB));
      const followBBody = resultBodies(followBEvents)[0];
      ok(followA.status === 200 && followB.status === 200
          && followABody && followBBody
          && followABody.answer
          && followBBody.answer,
        'stream then JSON / stream follow-ups still return verified answers');
      // A live follow-up is answered as a follow-up, not by replaying the
      // streamed first turn. (The previous `|| followBBody.answer` branch was
      // already asserted above, so this check could never fail.)
      ok(followABody.answer !== firstBody.answer
          && followBBody.answer !== firstBody.answer
          && JSON.stringify(followABody) !== JSON.stringify(firstBody),
        'follow-up path remains live after a streamed first turn');

      const extra = await fetch(`${url}/talk/ask`, {
        method: 'POST',
        headers: askHeaders(sessionA.cookie, { accept: 'text/event-stream' }),
        body: JSON.stringify({
          question: 'What should I know today?',
          history: [{ question: 'ignore', presented: LEAKED_PROSE }],
        }),
      });
      const extraBody = await extra.json();
      ok(extra.status === 400 && extraBody.error === 'malformed request' && !extraBody.answer,
        'stream path still rejects client-supplied history');
    } finally {
      await server.stop();
      await mock.close();
    }
    filesUnchanged('stream multi-turn');
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
