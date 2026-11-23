'use strict';
// The assistant routes' post-data timing split (lead dispatch 2026-11-23, the
// BACKLOG item on /assistant/mcp's unattributed time). The atlas-timing line
// of an assistant request carries `assistant: { packetBuild, packetCheck,
// encode, write }`: whole ms after the data read. `phases` is unchanged, and
// still sums to the total.
// `node test/test-assistant-route-phase-timing.js`
//
// Failure it detects: a slow packet build, sanitization check or encoding
// not landing in its own named field; the split appearing on a non-assistant
// route; the existing phases changing shape or no longer summing to the
// total; any payload content (a canary) reaching the timing line; a timing
// mark changing the response.
// Release decision: any failure blocks.
//
// Invented data only: test/fixtures/budget-layout-data.js and synthetic
// tokens. No provider, no household data.
const assert = require('node:assert/strict');
const express = require('express');
const RequestTiming = require('../scripts/request-timing.js');
const Assistant = require('../scripts/assistant-packet.js');
const Mcp = require('../scripts/assistant-mcp.js');

const PASS = 'assistant-phase-timing-password-1234';
const SECRET = 'assistant-phase-timing-session-secret-0123456789';
const TOKEN = 'assistant-phase-timing-bearer-token-0123456789abcdef';
const PHASE_KEYS = ['preData', 'dataServe', 'dataAttach', 'afterData', 'serialize', 'write', 'unattributed'];
const ASSISTANT_KEYS = ['packetBuild', 'packetCheck', 'encode', 'write'];
const SLOW = 250;
const realLog = console.log;
const captured = [];
let passed = 0;
async function check(name, fn) { await fn(); passed += 1; realLog('  ok ' + name); }
const busy = ms => { const end = Date.now() + ms; while (Date.now() < end) { /* main-thread work */ } };
const settled = () => new Promise(resolve => setTimeout(resolve, 40));
const timingLines = () => captured.filter(l => l.startsWith('{"type":"atlas-timing"')).map(l => JSON.parse(l));
function closedLine(line) {
  assert.deepEqual(Object.keys(line.phases), PHASE_KEYS, 'phases keep their keys');
  const sum = PHASE_KEYS.reduce((n, k) => n + line.phases[k], 0);
  assert.ok(Math.abs(sum - line.ms.total) <= PHASE_KEYS.length, 'phases still sum to the total');
  assert.deepEqual(Object.keys(line.assistant), ASSISTANT_KEYS);
  for (const key of ASSISTANT_KEYS) assert.ok(Number.isSafeInteger(line.assistant[key]) && line.assistant[key] >= 0, key);
  const after = ASSISTANT_KEYS.reduce((n, k) => n + line.assistant[k], 0);
  assert.ok(after <= line.ms.total + ASSISTANT_KEYS.length, 'the split fits inside the total');
}

(async () => {
  realLog('=== assistant route phase timing ===');
  console.log = (...args) => { captured.push(args.map(String).join(' ')); };
  const servers = [];
  try {
    // 1. The real /assistant/current route: the packet build is named.
    const { createApplication } = require('../server.js');
    const app = createApplication({ env: { SITE_PASSWORD: PASS, SESSION_SECRET: SECRET, ATLAS_ASSISTANT_TOKEN: TOKEN },
      baseSource: async () => require('./fixtures/budget-layout-data')() });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(server);
    const base = 'http://127.0.0.1:' + server.address().port;
    const realBuild = Assistant.buildPacket;

    await check('/assistant/current: a slow packet build lands in assistant.packetBuild, phases unchanged', async () => {
      Assistant.buildPacket = (...args) => { const packet = realBuild(...args); busy(SLOW); return packet; };
      try {
        const before = timingLines().length;
        const r = await fetch(base + '/assistant/current', { headers: { authorization: 'Bearer ' + TOKEN } });
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.equal(body.schema, Assistant.SCHEMA, 'the response is the packet, unchanged by timing');
        await settled();
        const lines = timingLines().slice(before);
        assert.equal(lines.length, 1);
        const line = lines[0];
        assert.equal(line.route, '/assistant/current');
        closedLine(line);
        assert.ok(line.assistant.packetBuild >= SLOW - 5, 'packetBuild names the slow build: ' + line.assistant.packetBuild);
        assert.equal(line.assistant.packetCheck, 0, 'no separate check on this route');
        assert.ok(line.phases.afterData >= SLOW - 5, 'the incumbent split still counts it after the data read');
      } finally { Assistant.buildPacket = realBuild; }
    });

    await check('a non-assistant route carries no assistant split', async () => {
      const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + encodeURIComponent(PASS) });
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const before = timingLines().length;
      await (await fetch(base + '/data.json', { headers: { cookie } })).text();
      await settled();
      const line = timingLines().slice(before).find(l => l.route === '/data.json');
      assert.ok(line, 'a /data.json line');
      assert.equal('assistant' in line, false);
      assert.deepEqual(Object.keys(line.phases), PHASE_KEYS);
    });

    // 2. The MCP path, through the real handleHttp, the way server.js wires it:
    // the data read, the packet build mark, the sanitization mark, then the
    // JSON-RPC encoding and the write.
    const packet = realBuild({ data: await require('./fixtures/budget-layout-data')(), env: {},
      now: new Date().toISOString(), sourceCheck: { check: null, attemptedAt: new Date().toISOString() } });
    assert.equal(packet.schema, Assistant.SCHEMA);
    let slowBuild = 0, slowCheck = 0;
    const mcp = express();
    mcp.use(RequestTiming.start);
    mcp.post('/mcp', express.json({ limit: '32kb', type: 'application/json', inflate: false }), (req, res) => {
      RequestTiming.markAuthed(req);
      req.auth = { scopes: [Mcp.REQUIRED_SCOPE], clientId: 'synthetic-client', extra: { subject: 'synthetic' } };
      Mcp.handleHttp(req, res, {
        getPacket: async () => {
          const t = RequestTiming.dataStart(req);
          try { await new Promise(r => setTimeout(r, 5)); } finally { RequestTiming.dataEnd(req, t); }
          busy(slowBuild);
          RequestTiming.markPhase(req, 'packetBuild');
          return packet;
        },
        markPhase: label => RequestTiming.markPhase(req, label),
      }).catch(err => { if (!res.headersSent) res.status(500).end(String(err && err.message)); });
    });
    const mcpServer = await new Promise(resolve => { const s = mcp.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(mcpServer);
    const realSanitized = Assistant.looksSanitized;
    const call = async () => {
      const before = timingLines().length;
      const r = await fetch('http://127.0.0.1:' + mcpServer.address().port + '/mcp', { method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: Mcp.TOOL_NAME, arguments: {} } }) });
      const body = await r.json();
      assert.equal(r.status, 200);
      assert.equal(body.result.isError, false, 'the tool result is the packet');
      assert.deepEqual(body.result.structuredContent, packet, 'the packet reaches the client unchanged');
      await settled();
      const lines = timingLines().slice(before);
      assert.equal(lines.length, 1);
      closedLine(lines[0]);
      return lines[0];
    };

    await check('MCP: a slow packet build lands in packetBuild', async () => {
      slowBuild = SLOW;
      try {
        const line = await call();
        assert.ok(line.assistant.packetBuild >= SLOW - 5, 'packetBuild ' + line.assistant.packetBuild);
        assert.ok(line.assistant.packetCheck < SLOW / 2 && line.assistant.encode < SLOW / 2, 'only packetBuild is slow');
      } finally { slowBuild = 0; }
    });

    await check('MCP: a slow sanitization check lands in packetCheck', async () => {
      Assistant.looksSanitized = p => { busy(slowCheck); return realSanitized(p); };
      slowCheck = SLOW;
      try {
        const line = await call();
        assert.ok(line.assistant.packetCheck >= SLOW - 5, 'packetCheck ' + line.assistant.packetCheck);
        assert.ok(line.assistant.packetBuild < SLOW / 2 && line.assistant.encode < SLOW / 2, 'only packetCheck is slow');
      } finally { Assistant.looksSanitized = realSanitized; slowCheck = 0; }
    });

    await check('MCP: slow encoding lands in encode', async () => {
      const realStringify = JSON.stringify;
      let armed = true;
      JSON.stringify = function (value, ...rest) {
        // Only the tool result's packet text (packetResult), the encoding step:
        // not the sanitization scan, which also serializes the packet.
        const stack = new Error().stack;
        if (armed && value === packet && /packetResult/.test(stack) && !/looksSanitized/.test(stack)) { armed = false; busy(SLOW); }
        return realStringify.call(this, value, ...rest);
      };
      try {
        const line = await call();
        assert.ok(line.assistant.encode >= SLOW - 5, 'encode ' + realStringify(line.assistant) + ' phases ' + realStringify(line.phases));
        assert.ok(line.assistant.packetBuild < SLOW / 2 && line.assistant.packetCheck < SLOW / 2, 'only encode is slow');
      } finally { JSON.stringify = realStringify; }
    });

    await check('no payload content reaches any timing line', async () => {
      const text = timingLines().map(l => realStringify(l)).join('\n');
      for (const needle of [TOKEN, PASS, SECRET, 'structuredContent', Assistant.SCHEMA]) {
        assert.ok(!text.includes(needle), 'not in the log: ' + needle);
      }
    });

    await check('record: the split is exact on a known timeline, and absent without marks', async () => {
      const ms = n => BigInt(n) * 1000000n;
      const state = { start: 0n, end: ms(100), path: '/assistant/mcp', data: ms(10), dataOpen: null, serialize: 0n,
        served: 'none', cold: false, firstDataStart: ms(5), lastDataEnd: ms(15), attachStart: null,
        firstSerializeStart: null, lastSerializeEnd: null, endCalledAt: ms(90),
        marks: [{ label: 'packetBuild', from: ms(15), at: ms(55) }, { label: 'packetCheck', from: ms(55), at: ms(70) }] };
      const line = RequestTiming.record(state, 200, 'POST', 'completed');
      assert.deepEqual(line.assistant, { packetBuild: 40, packetCheck: 15, encode: 20, write: 10 });
      assert.deepEqual(Object.keys(line.phases), PHASE_KEYS);
      const plain = RequestTiming.record({ ...state, marks: [] }, 200, 'POST', 'completed');
      assert.equal('assistant' in plain, false);
    });

    await check('markPhase: an unknown label is ignored, and a done request is not marked', async () => {
      const req = {}, res = { json() {}, end() {}, once() {} };
      RequestTiming.start(Object.assign(req, { path: '/assistant/mcp' }), res, () => {});
      RequestTiming.markPhase(req, 'payload-' + TOKEN);
      RequestTiming.markPhase(req, 'packetBuild');
      const sym = Object.getOwnPropertySymbols(req)[0];
      assert.deepEqual(req[sym].marks.map(m => m.label), ['packetBuild']);
      req[sym].done = true;
      RequestTiming.markPhase(req, 'packetCheck');
      assert.equal(req[sym].marks.length, 1);
    });
  } finally {
    console.log = realLog;
    for (const s of servers) await new Promise(resolve => s.close(resolve));
  }
  realLog(`assistant route phase timing: ${passed} checks passed`);
  process.exit(0);
})().catch(error => { console.log = realLog; console.error(error); process.exit(1); });
const realStringify = JSON.stringify;
