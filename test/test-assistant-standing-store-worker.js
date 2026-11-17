'use strict';
// Private synthetic subprocess worker. Never resolves production credentials.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const MCP = require('../scripts/assistant-mcp');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const Store = require('../scripts/assistant-standing-store');
const LM = require('../scripts/assistant-lunchmoney');
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const publicKey = fs.readFileSync(input.publicKeyPath, 'utf8');
const now = () => input.clock;
const adapter = Store.createAuthority({ root: input.root, publicKey, resource: input.resource, now,
  fault: point => {
    if (input.crash === point) process.exit(91);
    if (point === 'recovery-before-unlink' && input.readyPath) {
      fs.writeFileSync(input.readyPath, 'synthetic-gate-held');
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(input.releasePath) && Date.now() < deadline)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      if (!fs.existsSync(input.releasePath)) throw new Error('synthetic-recovery-barrier-timeout');
    }
  } });
async function main() {
  if (input.action === 'reserve') return adapter.reserve(input.attempt);
  if (input.action === 'finish') return adapter.finish(input.record);
  if (input.action === 'inspect') return adapter.list();
  if (input.action === 'recover') return adapter.recoverLock(input.envelope);
  if (input.action === 'service') {
    const categories = input.categories;
    const tx = () => JSON.parse(fs.readFileSync(input.providerPath, 'utf8'));
    const service = LM.createService({ env: {}, now, resolveToken: async () => input.token,
      standingCorrections: { enabled: true, notesEnabled: false, adapter },
      fetch: async (url, options) => {
        const u = new URL(url), p = u.pathname.replace('/v2', '');
        let data;
        if (options.method === 'PUT') {
          const current = tx(); Object.assign(current, JSON.parse(options.body));
          fs.writeFileSync(input.providerPath, JSON.stringify(current));
          fs.appendFileSync(input.writesPath, 'synthetic-put\n'); data = current;
        } else if (p === '/categories') data = { categories };
        else if (p.startsWith('/categories/')) data = categories.find(c => c.id === +p.split('/').pop());
        else if (p === '/plaid_accounts') data = { plaid_accounts: [{ id: 4, name: 'Synthetic Account' }] };
        else if (p === '/manual_accounts') data = { manual_accounts: [] };
        else if (p === '/transactions') data = { transactions: [tx()], has_more: false };
        else data = tx();
        return { ok: true, json: async () => JSON.parse(JSON.stringify(data)) };
      } });
    const auth = input.auth;
    const server = MCP.createServer(async () => null, { lunchMoney: service, auth });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'synthetic-durable-standing', version: '1' });
    await server.connect(serverSide); await client.connect(clientSide);
    let lastToolResponse;
    const call = async (name, args) => {
      lastToolResponse = await client.callTool({ name, arguments: args });
      return lastToolResponse.structuredContent;
    };
    try {
      const tools = (await client.listTools()).tools;
      assert.equal(tools.length, 12);
      const prepareDescription = tools.find(t => t.name === 'prepare_standing_lunchmoney_correction').description;
      assert.match(prepareDescription, /recorded delegated review/);
      assert.match(prepareDescription, /Notes and splits are unavailable/);
      assert.doesNotMatch(prepareDescription, /preserved\/additive note/);
      const cat = await call('get_lunchmoney_catalog', {});
      const rows = await call('get_lunchmoney_transactions', { startDate: '2026-10-01', endDate: '2026-10-31' });
      const categoryRef = cat.categories.find(c => c.name === 'Household').categoryRef;
      const review = { ...input.review, facts: { ...input.review.facts,
        items: input.review.facts.items.map(i => ({ description: i.description, amount: i.amount, categoryRef })) } };
      const args = { grantRef: input.grantRef, transactionRef: rows.rows[0].transactionRef, categoryRef, review };
      const forged = await client.callTool({ name: 'submit_lunchmoney_category_evidence',
        arguments: { ...args, review: { ...review, independentlyVerified: true } } }).catch(() => ({ isError: true }));
      assert.equal(forged.isError, true, 'caller cannot relabel source provenance');
      const evidence = await call('submit_lunchmoney_category_evidence', args);
      if (evidence.status !== 'evidence-recorded') return evidence;
      assert.equal(evidence.provenance.independentlyVerified, false);
      const preview = await call('prepare_standing_lunchmoney_correction', { grantRef: input.grantRef, evidenceRef: evidence.evidenceRef,
        transactionRef: rows.rows[0].transactionRef, changes: { categoryRef } });
      if (preview.status !== 'preview') return preview;
      const result = await call('apply_standing_lunchmoney_correction', { previewId: preview.previewId });
      if (result.status === 'applied') {
        assert.equal(result.auditReceipt.evidenceProvenance.independentlyVerified, false);
        const audit = await call('get_lunchmoney_correction_audit', { grantRef: input.grantRef });
        assert.equal(audit.receipts.length, 1); assert.equal(audit.receipts[0].outcome, 'applied');
        assert.equal(audit.receipts[0].acknowledged, true);
        assert.equal(audit.receipts[0].delegatedReview.facts.items[0].categoryRef, categoryRef);
        // Check both structured content and serialized MCP text content.
        assert.doesNotMatch(JSON.stringify(lastToolResponse),
          /category_id|transactionId|providerId|plaid_account_id|manual_account_id|tag_ids|beforeProvider/);
        assert.equal(JSON.stringify(lastToolResponse).includes(input.token), false);
      }
      return result;
    } finally { await client.close(); await server.close(); }
  }
  throw new Error('unknown-synthetic-worker');
}
main().then(result => console.log(JSON.stringify({ ok: true, result }))).catch(error => {
  console.log(JSON.stringify({ ok: false, reason: error.message })); process.exitCode = 2;
});
