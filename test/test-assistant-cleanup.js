'use strict';
const assert = require('node:assert/strict');
const LM = require('../scripts/assistant-lunchmoney');
const MCP = require('../scripts/assistant-mcp');
const Runtime = require('../scripts/assistant-standing-runtime');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const clone = value => structuredClone(value);
function fixture() {
  const tx = { id: 71, date: '2026-10-08', amount: '19.9900', currency: 'cad', payee: 'SHOP #71',
    original_name: 'BANK ORIGINAL SHOP #71', notes: '  Existing note\nKeep this exactly. ',
    category_id: 3, plaid_account_id: 4, manual_account_id: null, tag_ids: [22],
    is_pending: false, status: 'reviewed', custom_metadata: { bank: 'synthetic-preserved' },
    plaid_metadata: { transaction_id: 'synthetic-bank-identity' } };
  const state = { clock: Date.parse('2026-10-09T00:00:00Z'), tx, calls: [], writes: [],
    afterWrite: null, afterTagRead: null, ambiguous: false, token: 'synthetic-cleanup-token',
    categories: [{ id: 3, name: 'Groceries' }, { id: 8, name: 'Household' }],
    tags: [{ id: 22, name: 'Keep tag' }, { id: 24, name: 'Receipt matched' }],
    accounts: [{ id: 4, name: 'Bills' }, { id: 5, name: 'Weekly' }] };
  const auth = { principal: 'synthetic-owner', clientId: 'synthetic-client',
    scopes: [MCP.REQUIRED_SCOPE, LM.READ_SCOPE, LM.WRITE_SCOPE] };
  const service = LM.createService({ env: {}, now: () => state.clock,
    resolveToken: async () => state.token,
    fetch: async (url, options) => {
      const u = new URL(url), p = u.pathname.replace('/v2', '');
      state.calls.push({ path: p, method: options.method });
      let data;
      if (options.method !== 'GET') {
        assert.equal(options.method, 'PUT'); assert.equal(p, '/transactions/71');
        assert.equal(u.search, '?update_balance=false');
        const body = JSON.parse(options.body); state.writes.push(clone(body));
        if (state.ambiguous) throw new Error('synthetic-unknown-completion');
        // Independent implementation of documented additive-tag wire semantics.
        for (const [key, value] of Object.entries(body)) {
          if (key === 'additional_tag_ids') tx.tag_ids = [...new Set([...tx.tag_ids, ...value])].reverse();
          else tx[key] = value;
        }
        tx.updated_at = '2026-10-09T00:00:01Z';
        state.afterWrite?.(tx); data = tx;
      } else if (p === '/categories') data = { categories: state.categories };
      else if (p.startsWith('/categories/')) data = state.categories.find(c => c.id === Number(p.split('/').pop()));
      else if (p === '/tags') { data = { tags: state.tags }; state.afterTagRead?.(); }
      else if (p === '/plaid_accounts') data = { plaid_accounts: state.accounts };
      else if (p === '/manual_accounts') data = { manual_accounts: [] };
      else if (p === '/transactions') data = { transactions: [tx], has_more: false };
      else if (p === '/transactions/71') data = tx;
      else throw new Error('unexpected-synthetic-endpoint');
      return { ok: true, json: async () => clone(data) };
    } });
  async function lookup() {
    const catalog = await service.invoke('catalog', { includeTags: true }, auth);
    assert.equal(catalog.status, 'ok');
    const rows = await service.invoke('query', { startDate: '2026-10-01', endDate: '2026-10-09' }, auth);
    assert.equal(rows.status, 'ok');
    return { catalog, row: rows.rows[0], transactionRef: rows.rows[0].transactionRef };
  }
  async function preview(changes) { const found = await lookup();
    return service.invoke('prepare', { transactionRef: found.transactionRef, changes }, auth); }
  async function apply(preview) { return service.invoke('apply', { previewId: preview.previewId, confirmed: true }, auth); }
  return { state, service, auth, lookup, preview, apply };
}
async function withMcp(f, work) {
  const server = MCP.createServer(async () => null, { lunchMoney: f.service, auth: f.auth });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'synthetic-cleanup-proof', version: '1' });
  await server.connect(serverSide); await client.connect(clientSide);
  try { await work(client); } finally { await client.close(); await server.close(); }
}
(async () => {
  const f = fixture(), before = clone(f.state.tx), found = await f.lookup();
  assert.equal(f.service.standingEnabled, false);
  assert.deepEqual(Runtime.fromEnv({ env: {} }), { enabled: false, notesEnabled: false });
  assert.equal(found.row.originalBankDescription, before.original_name);
  assert.deepEqual(found.row.tags, [{ tagRef: found.catalog.tags[0].tagRef, name: 'Keep tag' }]);
  const changes = { payee: 'Readable Shop', categoryRef: found.catalog.categories[1].categoryRef,
    notesAppend: 'Receipt checked.', tagRefsAdd: [found.catalog.tags[1].tagRef] };
  const preview = await f.service.invoke('prepare', { transactionRef: found.transactionRef, changes }, f.auth);
  assert.equal(preview.status, 'preview'); assert.equal(f.state.writes.length, 0);
  assert.equal(preview.proposed.notes, '  Existing note\nKeep this exactly. \nReceipt checked.');
  assert.equal(preview.before.originalBankDescription, 'BANK ORIGINAL SHOP #71');
  assert.equal(preview.proposed.tagsAdded[0].name, 'Receipt matched');
  assert.equal((await f.service.invoke('apply', { previewId: preview.previewId, confirmed: false }, f.auth)).status, 'unavailable');
  assert.equal((await f.service.invoke('apply', { previewId: preview.previewId, confirmed: true },
    { ...f.auth, principal: 'another-user' })).status, 'unavailable');
  assert.equal((await f.apply(preview)).status, 'applied');
  // Independent expected wire body and originals, not a second calculator call.
  assert.deepEqual(f.state.writes, [{ category_id: 8, payee: 'Readable Shop',
    notes: '  Existing note\nKeep this exactly. \nReceipt checked.', additional_tag_ids: [24] }]);
  assert.deepEqual(f.state.tx.tag_ids.sort((a, b) => a - b), [22, 24]);
  for (const key of ['amount', 'currency', 'date', 'original_name', 'plaid_account_id',
    'manual_account_id', 'status', 'custom_metadata', 'plaid_metadata']) assert.deepEqual(f.state.tx[key], before[key]);
  await f.apply(preview); assert.equal(f.state.writes.length, 1);
  assert.doesNotMatch(JSON.stringify(preview), /category_id|plaid_account_id|manual_account_id|tag_ids|transactionId/);
  assert.equal(JSON.stringify(preview).includes(f.state.token), false);

  for (const [key, value] of Object.entries({ amount: '1.00', date: '2026-10-01', accountRef: found.row.accountRef,
    original_name: 'erase', tag_ids: [], delete: true, status: 'unreviewed', update_balance: true })) {
    assert.equal((await f.service.invoke('prepare', { transactionRef: found.transactionRef,
      changes: { [key]: value } }, f.auth)).reason, 'invalid-arguments');
  }
  assert.equal((await f.service.invoke('prepare', { transactionRef: found.transactionRef,
    changes: { tagRefsAdd: [found.catalog.categories[0].categoryRef] } }, f.auth)).status, 'unavailable');
  const legacy = await f.preview({ notes: 'Legacy additive input' });
  assert.equal(legacy.proposed.notes, f.state.tx.notes + '\nLegacy additive input');

  // Each unsolicited mutation must be detected by a separate provider GET.
  for (const mutate of [tx => { tx.original_name = 'ERASED'; }, tx => { tx.amount = '20.00'; },
    tx => { tx.notes = 'erased note'; }, tx => { tx.tag_ids = []; }, tx => { tx.status = 'unreviewed'; },
    tx => { tx.custom_metadata.bank = 'changed'; }]) {
    const x = fixture(); const p = await x.preview({ payee: 'Readable Shop' });
    x.state.afterWrite = mutate;
    assert.equal((await x.apply(p)).status, 'write-unverified');
    await x.apply(p); assert.equal(x.state.writes.length, 1);
  }
  for (const setup of [x => { x.state.tx.original_name = null; }, x => { x.state.tx.is_pending = true; },
    x => { delete x.state.tx.is_pending; },
    x => { x.state.tx.status = 'unreviewed'; }, x => { x.state.tx.split_parent_id = 123; },
    x => { x.state.tx.group_parent_id = 123; }]) {
    const x = fixture(); setup(x);
    assert.equal((await x.preview({ payee: 'Readable Shop' })).status, 'unavailable');
    assert.equal(x.state.writes.length, 0);
  }
  const missing = fixture(); missing.state.tx.tag_ids = null;
  const missingLookup = await missing.lookup(); assert.equal(missingLookup.row.tags, null);
  assert.equal((await missing.service.invoke('prepare', { transactionRef: missingLookup.transactionRef,
    changes: { tagRefsAdd: [missingLookup.catalog.tags[1].tagRef] } }, missing.auth)).status, 'unavailable');
  const stale = fixture(); const stalePreview = await stale.preview({ notesAppend: 'Checked.' });
  stale.state.tx.notes += '\nExternal note'; assert.equal((await stale.apply(stalePreview)).status, 'unavailable');
  assert.equal(stale.state.writes.length, 0);
  const expired = fixture(); const old = await expired.preview({ payee: 'Readable Shop' });
  expired.state.clock += LM.TTL + 1; assert.equal((await expired.apply(old)).status, 'unavailable');
  assert.equal(expired.state.writes.length, 0);
  for (const mutate of [tags => { tags[1].name = 'Changed tag'; }, tags => { tags[1].archived = true; },
    tags => { tags.pop(); }]) {
    const x = fixture(), { catalog, transactionRef } = await x.lookup();
    const p = await x.service.invoke('prepare', { transactionRef, changes: { tagRefsAdd: [catalog.tags[1].tagRef] } }, x.auth);
    mutate(x.state.tags); assert.notEqual((await x.apply(p)).status, 'applied'); assert.equal(x.state.writes.length, 0);
  }
  const uncertain = fixture(); const unverified = await uncertain.preview({ payee: 'Readable Shop' });
  uncertain.state.ambiguous = true; assert.equal((await uncertain.apply(unverified)).status, 'write-unverified');
  await uncertain.apply(unverified); assert.equal(uncertain.state.writes.length, 1);
  const raced = fixture(), racedLookup = await raced.lookup();
  const racedPreview = await raced.service.invoke('prepare', { transactionRef: racedLookup.transactionRef,
    changes: { notesAppend: 'Receipt checked.', tagRefsAdd: [racedLookup.catalog.tags[1].tagRef] } }, raced.auth);
  raced.state.afterTagRead = () => { raced.state.tx.notes += '\nExternal note during catalog check.'; };
  assert.equal((await raced.apply(racedPreview)).status, 'unavailable');
  assert.equal(raced.state.writes.length, 0);
  assert.equal(raced.state.tx.notes, '  Existing note\nKeep this exactly. \nExternal note during catalog check.');
  const rotated = fixture(), rotatedPreview = await rotated.preview({ payee: 'Readable Shop' });
  rotated.state.afterWrite = () => { rotated.state.token = 'synthetic-rotated-credential'; };
  assert.equal((await rotated.apply(rotatedPreview)).status, 'write-unverified');
  await rotated.apply(rotatedPreview); assert.equal(rotated.state.writes.length, 1);

  // A clear directional display label, without changing category or moving funds.
  const transfer = fixture(), transferBefore = clone(transfer.state.tx), transferFound = await transfer.lookup();
  const label = { fromAccountRef: transferFound.catalog.accounts[0].accountRef,
    toAccountRef: transferFound.catalog.accounts[1].accountRef };
  const transferPreview = await transfer.service.invoke('prepare', { transactionRef: transferFound.transactionRef,
    changes: { transferLabel: label } }, transfer.auth);
  assert.equal(transferPreview.proposed.payee, 'Transfer: Bills → Weekly');
  assert.match(transferPreview.proposed.transferLabel.meaning, /no money movement/);
  assert.equal((await transfer.apply(transferPreview)).status, 'applied');
  assert.deepEqual(transfer.state.writes, [{ payee: 'Transfer: Bills → Weekly' }]);
  assert.equal(transfer.state.tx.amount, transferBefore.amount); assert.equal(transfer.state.tx.category_id, 3);
  assert.equal(transfer.state.tx.notes, transferBefore.notes);
  assert.equal((await transfer.service.invoke('prepare', { transactionRef: transferFound.transactionRef,
    changes: { transferLabel: { fromAccountRef: label.toAccountRef, toAccountRef: label.fromAccountRef } } }, transfer.auth)).status, 'unavailable');
  transfer.state.tx.amount = '-19.9900'; transfer.state.tx.plaid_account_id = 5;
  assert.equal((await transfer.service.invoke('prepare', { transactionRef: transferFound.transactionRef,
    changes: { transferLabel: label } }, transfer.auth)).status, 'preview');
  transfer.state.tx.amount = '0.0000';
  assert.equal((await transfer.service.invoke('prepare', { transactionRef: transferFound.transactionRef,
    changes: { transferLabel: label } }, transfer.auth)).status, 'unavailable');
  transfer.state.tx.amount = '19.9900'; transfer.state.tx.plaid_account_id = 4; transfer.state.tx.manual_account_id = 4;
  assert.equal((await transfer.service.invoke('prepare', { transactionRef: transferFound.transactionRef,
    changes: { transferLabel: label } }, transfer.auth)).status, 'unavailable');

  const mcpFixture = fixture();
  await withMcp(mcpFixture, async client => {
    const tools = await client.listTools(); assert.equal(tools.tools.length, 8);
    assert.equal(tools.tools.some(t => /standing/.test(t.name)), false);
    const descriptor = tools.tools.find(t => t.name === 'prepare_lunchmoney_cleanup_instruction');
    assert.equal(descriptor.annotations.readOnlyHint, true);
    assert.deepEqual(descriptor._meta.securitySchemes[0].scopes, [MCP.REQUIRED_SCOPE, LM.READ_SCOPE]);
    const result = await client.callTool({ name: descriptor.name, arguments: { name: 'Receipt cleanup',
      changes: { payee: 'Readable Shop', categoryName: 'Household', notesAppend: 'Receipt checked.', tagNamesAdd: ['Receipt matched'] } } });
    const recipe = result.structuredContent.instruction;
    assert.equal(result.structuredContent.automaticEdits, false);
    assert.equal(mcpFixture.state.calls.length, 0, 'recipe creation has no provider side effect');
    const catalog = await client.callTool({ name: 'get_lunchmoney_catalog', arguments: { includeTags: true } });
    assert.equal(catalog.structuredContent.tags[1].name, 'Receipt matched');
    const rows = await client.callTool({ name: 'get_lunchmoney_transactions',
      arguments: { startDate: '2026-10-01', endDate: '2026-10-09' } });
    const exactPreview = await client.callTool({ name: 'prepare_lunchmoney_edit',
      arguments: { transactionRef: rows.structuredContent.rows[0].transactionRef, cleanupInstruction: recipe } });
    assert.equal(exactPreview.structuredContent.status, 'preview'); assert.equal(mcpFixture.state.writes.length, 0);
    const exactApply = await client.callTool({ name: 'apply_lunchmoney_edit',
      arguments: { previewId: exactPreview.structuredContent.previewId, confirmed: true } });
    assert.equal(exactApply.structuredContent.status, 'applied');
    assert.deepEqual(mcpFixture.state.writes, [{ category_id: 8, payee: 'Readable Shop',
      notes: '  Existing note\nKeep this exactly. \nReceipt checked.', additional_tag_ids: [24] }]);
    // Reuse the portable recipe across independent service instances/salts.
    for (let n = 0; n < 2; n++) {
      const x = fixture(), { transactionRef } = await x.lookup();
      const p = await x.service.invoke('prepare', { transactionRef, cleanupInstruction: recipe }, x.auth);
      assert.equal(p.status, 'preview'); assert.equal(x.state.writes.length, 0);
      assert.equal((await x.apply(p)).status, 'applied');
      const again = await x.service.invoke('prepare', { transactionRef, cleanupInstruction: recipe }, x.auth);
      assert.equal(again.status, 'no-changes'); assert.equal(x.state.writes.length, 1);
      assert.equal(x.state.tx.notes, '  Existing note\nKeep this exactly. \nReceipt checked.');
    }
    const duplicate = fixture(); duplicate.state.categories.push({ id: 9, name: 'Household' });
    const { transactionRef } = await duplicate.lookup();
    assert.equal((await duplicate.service.invoke('prepare', { transactionRef, cleanupInstruction: recipe }, duplicate.auth)).status, 'unavailable');
    assert.equal(duplicate.state.writes.length, 0);
    const rejected = await client.callTool({ name: descriptor.name,
      arguments: { name: 'Unsafe recipe', changes: { amount: '1.00' } } });
    assert.equal(rejected.isError, true);
  });
  const pure = fixture();
  assert.equal((await pure.service.invoke('cleanupInstruction', { name: 'Append only', changes: { notesAppend: 'Checked.' } },
    { ...pure.auth, scopes: [LM.READ_SCOPE] })).status, 'instruction');
  assert.equal(pure.state.calls.length, 0);
  assert.equal((await pure.service.invoke('cleanupInstruction', { name: 'Append only', changes: { notesAppend: 'Checked.' } },
    { ...pure.auth, scopes: [] })).reason, 'transaction-read-scope-required');
  console.log('Lunch Money cleanup: real MCP recipes/preview/apply, original descriptions, additive notes/tags, labels, exact readback and no automatic authority PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
