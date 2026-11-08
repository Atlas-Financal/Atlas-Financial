'use strict';
// The OAuth MCP route refuses an oversized or empty JSON-RPC batch before any
// tool handler runs, and the lockfile pins an MCP SDK release outside the
// published server-side advisories. Synthetic packet and auth only.
//   node test/test-assistant-mcp-batch-cap.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const Mcp = require('../scripts/assistant-mcp.js');

const ROOT = path.join(__dirname, '..');

// 1. Lockfile and manifest: at or above 1.32.0, which fixes GHSA-f897-62hf-6gxq
// (fixed 1.30.1) and the later server advisories fixed in 1.31.0 / 1.32.0.
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const atLeast = (version, floor) => {
  const a = version.split('.').map(Number), b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};
const locked = lock.packages['node_modules/@modelcontextprotocol/sdk'].version;
assert.ok(atLeast(locked, '1.32.0'), 'locked MCP SDK ' + locked + ' is patched');
assert.ok(atLeast(pkg.dependencies['@modelcontextprotocol/sdk'].replace(/^\^/, ''), '1.32.0'),
  'package.json range floor is patched');
assert.equal(lock.packages[''].dependencies['@modelcontextprotocol/sdk'], pkg.dependencies['@modelcontextprotocol/sdk']);

// 2. Predicate.
assert.equal(Mcp.MAX_BATCH_MESSAGES, 16);
assert.equal(Mcp.batchRefusal({ jsonrpc: '2.0', id: 1, method: 'ping' }), null, 'single message is not a batch');
assert.equal(Mcp.batchRefusal(new Array(16).fill({})), null, 'a batch at the cap passes');
assert.match(Mcp.batchRefusal(new Array(17).fill({})), /must not exceed 16/);
assert.match(Mcp.batchRefusal([]), /empty batch/);

// 3. Over HTTP, through express.json like server.js: a refused batch never
// reaches a tool handler.
const call = i => ({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: Mcp.TOOL_NAME, arguments: {} } });
let packetReads = 0;
const app = express();
app.post('/mcp', express.json({ limit: '32kb', type: 'application/json', inflate: false }), (req, res) => {
  req.auth = { scopes: [Mcp.REQUIRED_SCOPE], clientId: 'synthetic-client', extra: { subject: 'synthetic' } };
  Mcp.handleHttp(req, res, { getPacket: () => { packetReads += 1; return { schema: 'synthetic', synthetic: true }; } })
    .catch(err => { if (!res.headersSent) res.status(500).end(String(err && err.message)); });
});

function post(port, body) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, json: JSON.parse(await r.text()) }));
}

const server = app.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  try {
    for (const size of [17, 40, 101]) {
      packetReads = 0;
      const r = await post(port, Array.from({ length: size }, (_, i) => call(i)));
      assert.equal(r.status, 400, size + ' messages refused');
      assert.equal(r.json.error.code, -32600);
      assert.equal(r.json.id, null);
      assert.equal(packetReads, 0, size + ' messages: no tool handler ran');
    }
    const empty = await post(port, []);
    assert.equal(empty.status, 400, 'empty batch refused');

    packetReads = 0;
    const small = await post(port, [call(0), call(1)]);
    assert.equal(small.status, 200, 'small batch served');
    assert.ok(Array.isArray(small.json) && small.json.length === 2, 'two responses');
    assert.equal(packetReads, 2, 'the spy observes tool calls when allowed');

    const single = await post(port, { jsonrpc: '2.0', id: 9, method: 'ping' });
    assert.equal(single.status, 200, 'single message served');
    console.log('MCP batch cap refuses before any tool runs; SDK patched: ok');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
