'use strict';
// Synthetic full household evidence + real parser/overlay/Forecast + actual
// private authority on POSIX. No provider credential or household data is read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const LM = require('../scripts/assistant-lunchmoney');
const MCP = require('../scripts/assistant-mcp');
const P = require('../scripts/assistant-standing-corrections');
const C = require('../scripts/assistant-cleanup-policy');
const E = require('../scripts/assistant-cleanup-effects');
const S = require('../scripts/assistant-standing-store');
const Live = require('../scripts/live-plan');
const F = require('../public/forecast');
const LmGroups = require('./lm-groups-fixture.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const clone = x => JSON.parse(JSON.stringify(x));
const op = (type, n) => type + '-' + n.toString(16).padStart(24, '0');
function household() {
  const f = require('./fixtures/household-path-data').fixture('resolved');
  for (const tx of f.payload.transactions) Object.assign(tx, { plaid_account_id: tx.account_id, manual_account_id: null,
    amount: String(tx.amount), original_name: tx.payee, notes: 'Existing note', tag_ids: [22], status: 'reviewed',
    plaid_metadata: tx.plaid_metadata ?? null, custom_metadata: tx.custom_metadata ?? null });
  for (const cat of f.payload.categories) Object.assign(cat, { is_income: cat.is_income === true,
    exclude_from_budget: cat.exclude_from_budget === true, exclude_from_totals: cat.exclude_from_totals === true });
  f.payload.tags = [{ id: 22, name: 'Receipt' }, { id: 33, name: 'Checked' }, { id: 44, name: 'Amanda' }];
  return { data: f.data, accountMap: f.map, periods: f.periods,
    identity: require('../docs/connectivity/transaction-identity.json'), payload: f.payload };
}
const instruction = { schema: 'atlas-lunchmoney-cleanup-instruction/v1', name: 'Researched cafe cleanup',
  changes: { payee: 'Synthetic Cafe', notesAppend: 'Receipt checked.', tagNamesAdd: ['Checked'] } };
const nameOnly = { ...instruction, name: 'Researched name only', changes: { payee: 'Synthetic Cafe' } };
async function fixture(real = false, recipe = instruction, runtime = false) {
  const inputs = household(), tx = inputs.payload.transactions.find(t => t.id === 91004);
  if (runtime) inputs.accountMap.scope = 'synthetic-loopback-runtime-test';
  const clock = Date.parse(inputs.payload.fetchedAt), token = 'synthetic-routine-token';
  const now = () => Date.parse(inputs.payload.fetchedAt);
  const resource = 'https://atlas.example/assistant/mcp';
  const auth = { principal: 'synthetic-owner', clientId: 'synthetic-client', resource,
    scopes: [MCP.REQUIRED_SCOPE, LM.READ_SCOPE, LM.WRITE_SCOPE, P.SCOPE] };
  const context = { resource, budgetRef: 'synthetic-budget', credentialVersion: 'v1', credentialDigest: S.digest(token),
    contextVersion: 'v2', parserRevision: real || runtime ? E.revision() : 'synthetic-real-parser', ruleEffects: 'none-verified', notesEnabled: false,
    cleanupEnabled: true, financialContextDigest: E.contextDigest(inputs),
    providerProof: { kind: 'synthetic-test', reference: 'synthetic-contract', digest: S.ownerDigest('synthetic'), expiresAt: clock + 86400000,
      cleanupFields: ['category_id', 'payee', 'notes', 'additional_tag_ids'], updateBalanceFalse: true } };
  const grant = { schema: C.SCHEMA, grantRef: op('grant', 100), revision: 1, principal: auth.principal, clientId: auth.clientId,
    resource, budgetRef: context.budgetRef, credentialVersion: 'v1', contextVersion: 'v2', parserRevision: context.parserRevision,
    approvalRef: op('approval', 100), approvedByOwner: true, createdAt: clock, expiresAt: clock + 86400000,
    revokedAt: null, suspended: false, accounts: [{ type: 'plaid', id: 1001 }, { type: 'plaid', id: 1002 }],
    startDate: '2026-08-01', endDate: '2026-08-31', categoryTransitions: [], allowNotes: !!recipe.changes.notesAppend,
    evidencePolicy: C.POLICY, cleanupInstructions: [clone(recipe)], maxAttempts: 3, attempts: 0 };
  let adapter, root, dir, publicKey;
  const memory = { evidence: {}, attempts: [] };
  if (real) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-routine-synthetic-')); root = path.join(dir, 'authority');
    const keys = crypto.generateKeyPairSync('ed25519'); publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' });
    const publicKeyPath = path.join(dir, 'owner-public.pem'); fs.writeFileSync(publicKeyPath, publicKey, { mode: 0o600 });
    S.initialize({ root, publicKey, contextEnvelope: S.sign({ kind: 'context', context }, keys.privateKey) });
    adapter = S.createAuthority({ root, publicKey, resource, now });
    await adapter.ownerUpdate(S.sign({ kind: 'grant', grant }, keys.privateKey));
    await assert.rejects(adapter.ownerUpdate({ payload: { kind: 'grant', grant }, signature: '' }), /signature/);
    const invalid = { ...grant, grantRef: op('grant', 101), cleanupInstructions: [{ ...instruction, changes: { amount: '1' } }] };
    await assert.rejects(adapter.ownerUpdate(S.sign({ kind: 'grant', grant: invalid }, keys.privateKey)), /invalid-cleanup/);
    const Runtime = require('../scripts/assistant-standing-runtime');
    const configured = Runtime.fromEnv({ env: { ATLAS_STANDING_CORRECTIONS_ENABLED: 'true', ATLAS_STANDING_STORE_PATH: root,
      ATLAS_STANDING_OWNER_PUBLIC_KEY_PATH: publicKeyPath }, resource, now, testOnly: true });
    assert.equal(configured.enabled, true); assert.equal(configured.cleanupEnabled, true);
    assert.equal(typeof configured.adapter.cleanupEffects, 'function', 'real production effect consumer is wired');
    assert.equal(Runtime.fromEnv({ env: {}, resource }).enabled, false);
    assert.equal(Runtime.fromEnv({ env: { ATLAS_STANDING_CORRECTIONS_ENABLED: 'true', ATLAS_STANDING_STORE_PATH: root,
      ATLAS_STANDING_OWNER_PUBLIC_KEY_PATH: publicKeyPath }, resource, now }).enabled, false,
      'synthetic provider proof cannot activate production');
    adapter = configured.adapter;
  } else {
    // Durability is proved with the real store below on CI; this local adapter
    // exercises exactly the same service path and real financial evaluator.
    adapter = { durable: true, context: async () => clone(context), grant: async () => clone(grant),
      evidence: async ref => clone(memory.evidence[ref] || null),
      admit: async input => {
        C.review({ ...input, context, grant, now: now() });
        const evidenceRef = op('evidence', Object.keys(memory.evidence).length + 1);
        const e = { schema: 'atlas-delegated-cleanup-evidence/v1', evidenceRef, grantRef: grant.grantRef, grantRevision: 1,
          policy: C.POLICY, contextVersion: 'v2', parserRevision: context.parserRevision, resolution: 'resolved',
          attestedBy: 'delegated-client-review', expiresAt: now() + 600000, transactionId: input.tx.id,
          beforeFingerprint: S.digest(input.tx), body: input.body, cleanupInstruction: input.cleanupInstruction,
          metadataContext: input.metadataContext, categoryContext: input.categoryContext,
          ...(input.transferProof ? { transferProof: input.transferProof } : {}),
          provenance: { kind: 'delegated-client-review', independentlyVerified: false, ...auth, reviewDigest: S.ownerDigest(input.review) } };
        memory.evidence[evidenceRef] = clone(e); return { evidenceRef, expiresAt: e.expiresAt };
      }, reserve: async a => { grant.attempts++; const reservation = { attemptRef: op('attempt', grant.attempts),
        grantRef: grant.grantRef, grantRevision: 1, durable: true, authorized: true };
        memory.attempts.push({ ...clone(a), reservation }); return reservation; },
      verifyReservation: async a => ({ valid: true, attemptRef: a.reservation.attemptRef }),
      suspend: async () => { grant.suspended = true; },
      finish: async r => { memory.attempts.at(-1).terminal = clone(r); return { receiptRef: op('receipt', grant.attempts),
        actorRef: op('actor', 1), attemptRef: r.reservation.attemptRef, durable: true, recordFingerprint: S.digest(r) }; },
      acknowledgeVerified: async () => ({ acknowledged: true }), audit: async () => [] };
  }
  const state = { inputs, tx, context, grant, auth, adapter, writes: [], root, dir, publicKey,
    files: [], afterWrite: null, beforeEffects: null };
  adapter.cleanupEffects = async input => { if (state.beforeEffects) await state.beforeEffects();
    return E.evaluate({ inputs, ...input, parserRevision: context.parserRevision }); };
  state.service = LM.createService({ env: {}, now, resolveToken: async () => token,
    standingCorrections: { enabled: true, cleanupEnabled: true, notesEnabled: false, adapter },
    fetch: async (url, options) => {
      const u = new URL(url), endpoint = u.pathname.replace('/v2', ''); let data;
      if (options.method !== 'GET') {
        const body = JSON.parse(options.body); state.writes.push({ method: options.method, endpoint, query: u.search, body });
        assert.equal(Object.keys(body).some(k => ['amount', 'date', 'original_name', 'tag_ids', 'account_id', 'child_transactions'].includes(k)), false);
        Object.assign(tx, Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'additional_tag_ids')));
        if (body.additional_tag_ids) tx.tag_ids = [...new Set([...tx.tag_ids, ...body.additional_tag_ids])].reverse();
        if (state.afterWrite) state.afterWrite(tx); data = tx;
      } else if (endpoint === '/categories') data = { categories: inputs.payload.categories };
      else if (endpoint.startsWith('/categories/')) data = inputs.payload.categories.find(c => c.id === Number(endpoint.split('/').pop()));
      else if (endpoint === '/tags') data = { tags: inputs.payload.tags };
      else if (endpoint === '/plaid_accounts') data = { plaid_accounts: [{ id: 1001, name: 'Synthetic Bills' }, { id: 1002, name: 'Synthetic Weekly' }] };
      else if (endpoint === '/manual_accounts') data = { manual_accounts: [] };
      else if (endpoint === '/transactions') data = { transactions: [tx], has_more: false };
      // Bulk include_metadata reads omit files by default. The by-ID endpoint
      // includes them and need not serialize shared fields in the same order.
      else data = Object.fromEntries(Object.entries({ ...tx, files: state.files }).reverse());
      return { ok: true, json: async () => clone(data) };
    } });
  state.review = () => ({ schema: C.POLICY, status: 'resolved', sources: [{ system: 'user-provided',
    reference: 'Synthetic researched receipt', excerptDigest: S.ownerDigest('synthetic receipt') }],
    facts: { date: tx.date, payee: tx.payee, originalBankDescription: tx.original_name, amount: tx.amount, currency: tx.currency },
    supportedChanges: clone(recipe.changes), rationale: 'Exact researched receipt supports these display additions.', issues: [] });
  state.ref = async () => (await state.service.invoke('query', { startDate: '2026-08-01', endDate: '2026-08-31' }, auth)).rows[0].transactionRef;
  state.prepare = async () => {
    const transactionRef = await state.ref();
    const admission = await state.service.invoke('submitCleanupEvidence', { transactionRef, grantRef: grant.grantRef,
      cleanupInstruction: recipe, review: state.review() }, auth);
    assert.equal(admission.status, 'evidence-recorded', JSON.stringify(admission));
    return state.service.invoke('prepareStanding', { transactionRef, grantRef: grant.grantRef,
      evidenceRef: admission.evidenceRef, cleanupInstruction: recipe }, auth);
  };
  return state;
}
async function runtimeFixture(real = false, recipe = instruction) {
  const state = await fixture(real, recipe, true);
  const dir = state.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-runtime-synthetic-'));
  const projectRoot = path.join(dir, 'synthetic-project');
  // Only deployed code and invented inputs are copied; never household data,
  // credentials or the workspace's data.json. The real runtime reads these files.
  for (const folder of ['scripts', 'public']) {
    fs.mkdirSync(path.join(projectRoot, folder), { recursive: true });
    for (const name of fs.readdirSync(path.resolve(__dirname, '..', folder))) if (name.endsWith('.js')) {
      fs.copyFileSync(path.resolve(__dirname, '..', folder, name), path.join(projectRoot, folder, name));
    }
  }
  fs.mkdirSync(path.join(projectRoot, 'docs/connectivity'), { recursive: true });
  for (const [name, value] of [['data.json', state.inputs.data], ['public/periods.json', state.inputs.periods],
    ['docs/connectivity/transaction-identity.json', state.inputs.identity]]) fs.writeFileSync(path.join(projectRoot, name), JSON.stringify(value));
  const requests = [], proofs = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'), endpoint = url.pathname.replace('/v2', '');
    requests.push({ method: req.method, endpoint, query: Object.fromEntries(url.searchParams) });
    if (req.method !== 'GET' || req.headers.authorization !== 'Bearer synthetic-routine-token') {
      res.writeHead(403); res.end('{}'); return;
    }
    let data;
    if (endpoint === '/me') data = {};
    else if (endpoint === '/plaid_accounts') data = { plaid_accounts: state.inputs.payload.accounts };
    else if (endpoint === '/manual_accounts') data = { manual_accounts: [] };
    else if (endpoint === '/categories') data = { categories: state.inputs.payload.categories };
    else if (endpoint === '/tags') data = { tags: state.inputs.payload.tags };
    else if (endpoint === '/transactions') data = { transactions: state.incompletePending && url.searchParams.get('is_pending') === 'true' ? []
      : state.inputs.payload.transactions.filter(tx =>
      url.searchParams.get('is_pending') === 'true' ? tx.is_pending === true
        : tx.date >= url.searchParams.get('start_date') && tx.date <= url.searchParams.get('end_date')),
      has_more: state.incompletePending && url.searchParams.get('is_pending') === 'true' || false };
    else { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { LUNCHMONEY_ACCESS_TOKEN: 'synthetic-routine-token',
    ATLAS_LUNCHMONEY_API_BASE: 'http://127.0.0.1:' + server.address().port + '/v2',
    ATLAS_PROVIDER_ACCOUNT_MAP_JSON: JSON.stringify(state.inputs.accountMap) };
  const now = () => Date.parse(state.inputs.payload.fetchedAt);
  state.runtime = { env, projectRoot, requests, proofs };
  state.close = async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  let actual;
  try {
    if (real) {
      const configured = require('../scripts/assistant-standing-runtime').fromEnv({ env: { ...env,
        ATLAS_STANDING_CORRECTIONS_ENABLED: 'true', ATLAS_STANDING_STORE_PATH: state.root,
        ATLAS_STANDING_OWNER_PUBLIC_KEY_PATH: path.join(dir, 'owner-public.pem') }, resource: state.auth.resource,
        projectRoot, now, testOnly: true });
      assert.equal(configured.cleanupEnabled, true, 'actual configured runtime uses the synthetic file installation');
      actual = configured.adapter.cleanupEffects;
    } else actual = async input => E.runtimeEffects({ ...input, env, projectRoot, context: await state.adapter.context(), now });
  } catch (error) { await state.close(); throw error; }
  state.adapter.cleanupEffects = async input => {
    if (state.beforeEffects) await state.beforeEffects();
    const proof = await actual(input); proofs.push(clone(proof)); return proof;
  };
  return state;
}
function independentFigures(inputs) {
  const r = Live.fromObservation({ data: inputs.data, payload: inputs.payload, accountMap: inputs.accountMap, identity: inputs.identity });
  const packet = r.data.liveOverlay.currentPeriodActuals;
  assert.equal(packet.transactions.filter(t => t.categoryLabel === 'Groceries' && t.amount > 0 && !t.pending).reduce((s,t) => s+t.amount,0), 80+52+23);
  assert.equal(packet.transactions.filter(t => t.categoryLabel === 'Restaurants').reduce((s,t) => s+t.amount,0), 30);
  assert.equal(r.data.plan.startingCash.breakdown.filter(c => c.id !== 'savings').reduce((s,c) => s+c.value,0), 300+100+1000-120-80-30-35+20);
  const forecast = F.baselineTrajectory(r.data.plan, r.data.debts, r.data.meta.asOf,
    { ...r.data.plan.defaults, periods: inputs.periods, currentPeriodActuals: packet });
  assert.equal(forecast.status, 'ready'); assert.equal(forecast.payPeriods[0].income.amount, 0);
  assert.equal(forecast.payPeriods[1].income.amount, 1000);
}
async function main() {
  const call = { method: 'tools/call', params: { name: 'submit_lunchmoney_cleanup_evidence' } };
  assert.equal(require('../scripts/assistant-oauth').classifyToolCalls(call, true), 'standing');
  assert.equal(require('../scripts/assistant-oauth').classifyToolCalls(call, false), 'other');
  const wire = household(), bulk = wire.payload.transactions.find(t => t.id === 91004);
  const byId = Object.fromEntries(Object.entries({ ...clone(bulk), files: [] }).reverse());
  assert.equal(E.evaluate({ inputs: wire, tx: byId, body: { payee: 'Synthetic Cafe' }, parserRevision: 'synthetic' }).metadataNeutral, true,
    'documented by-ID expansion and JSON field order do not change the observed transaction');
  for (const changed of [{ amount: '31' }, { notes: 'External note' }, { original_name: 'Other bank description' },
    { category_id: 13 }, { tag_ids: [] }, { status: 'unreviewed' }, { plaid_metadata: { changed: true } },
    { custom_metadata: { changed: true } }, { unexpected_provider_field: true }]) {
    assert.throws(() => E.evaluate({ inputs: wire, tx: { ...byId, ...changed }, body: {}, parserRevision: 'synthetic' }),
      /cleanup-financial-proof-unavailable/, 'only omitted attachment expansion is compatible; other field differences remain stale');
  }
  bulk.files = [];
  assert.throws(() => E.evaluate({ inputs: wire, tx: { ...byId, files: [{ name: 'Changed attachment' }] }, body: {}, parserRevision: 'synthetic' }),
    /cleanup-financial-proof-unavailable/, 'attachments are compared when both responses supply them');
  for (const recipe of [nameOnly, { ...instruction, name: 'Note only', changes: { notesAppend: 'Receipt checked.' } }]) {
    const named = await fixture(false, recipe), preview = await named.prepare();
    assert.equal(preview.status, 'preview', JSON.stringify(preview));
    const applied = await named.service.invoke('applyStanding', { previewId: preview.previewId }, named.auth);
    assert.equal(applied.status, 'applied', JSON.stringify(applied));
    for (const position of ['before', 'proposed', 'after']) {
      assert.deepEqual(applied.auditReceipt[position].tags.map(t => t.name), ['Receipt'],
        'history snapshots known existing tag names without a prior includeTags catalog or a tag addition');
    }
  }
  const runtime = await runtimeFixture();
  try {
    runtime.beforeEffects = async () => { runtime.inputs.payload.fetchedAt = new Date(Date.parse(runtime.inputs.payload.fetchedAt) + 1000).toISOString(); };
    const preview = await runtime.prepare(); assert.equal(preview.status, 'preview', JSON.stringify(preview));
    const applied = await runtime.service.invoke('applyStanding', { previewId: preview.previewId }, runtime.auth);
    assert.equal(applied.status, 'applied', JSON.stringify(applied)); assert.equal(runtime.writes.length, 1);
    assert.equal(runtime.runtime.proofs.length, 4, 'admission, preview, authorization and under-lease proof all use runtimeEffects');
    assert.notEqual(runtime.runtime.proofs[1].categoryBefore, runtime.runtime.proofs.at(-1).categoryBefore,
      'actual runtime samples advancing observation time instead of freezing it');
    assert.equal(applied.auditReceipt.financialEffects.categoryBefore, runtime.runtime.proofs.at(-1).categoryBefore);
    assert.equal((await runtime.adapter.grant(runtime.grant.grantRef)).suspended, false);
    assert(runtime.runtime.requests.every(r => r.method === 'GET'));
    assert(runtime.runtime.requests.filter(r => r.endpoint === '/transactions').every(r => r.query.include_metadata === 'true' && r.query.include_files === undefined));
    assert(runtime.runtime.requests.some(r => r.query.is_pending === 'true' && !r.query.start_date && !r.query.end_date));
  } finally { await runtime.close(); }
  for (const fault of ['credential', 'parser', 'pending', 'unsafe-final-tag']) {
    const bad = await runtimeFixture();
    try {
      const preview = await bad.prepare(); assert.equal(preview.status, 'preview', JSON.stringify(preview));
      let proofs = 0;
      bad.beforeEffects = async () => {
        bad.inputs.payload.fetchedAt = new Date(Date.parse(bad.inputs.payload.fetchedAt) + 1000).toISOString();
        if (fault === 'credential') bad.runtime.env.LUNCHMONEY_ACCESS_TOKEN = op('synthetic-token', 2);
        if (fault === 'parser') fs.appendFileSync(path.join(bad.runtime.projectRoot, 'scripts/assistant-cleanup-effects.js'), '\n// Changed deployed parser\n');
        if (fault === 'pending') bad.incompletePending = true;
        if (fault === 'unsafe-final-tag' && ++proofs === 2) bad.inputs.payload.tags.find(t => t.id === 33).name = 'Dale';
      };
      assert.equal((await bad.service.invoke('applyStanding', { previewId: preview.previewId }, bad.auth)).status, 'unavailable', fault);
      assert.equal(bad.writes.length, 0, 'real runtime must refuse ' + fault + ' before PUT');
    } finally { await bad.close(); }
  }
  const f = await fixture(); independentFigures(f.inputs);
  const before = clone(f.tx), p = await f.prepare(); assert.equal(p.status, 'preview', JSON.stringify(p));
  assert.equal(p.automaticEdits, true); assert.equal(f.writes.length, 0);
  const result = await f.service.invoke('applyStanding', { previewId: p.previewId }, f.auth);
  assert.equal(result.status, 'applied', JSON.stringify(result)); assert.equal(result.auditReceipt.before.originalBankDescription, before.original_name);
  assert.deepEqual(f.writes, [{ method: 'PUT', endpoint: '/transactions/' + before.id, query: '?update_balance=false',
    body: { payee: 'Synthetic Cafe', notes: 'Existing note\nReceipt checked.', additional_tag_ids: [33] } }]);
  assert.equal(f.tx.original_name, before.original_name); assert.equal(f.tx.amount, '30'); assert.deepEqual(f.tx.tag_ids.sort(), [22,33]);
  independentFigures(f.inputs);
  assert.equal((await f.service.invoke('applyStanding', { previewId: p.previewId }, f.auth)).status, 'unavailable');
  const noOp = await f.service.invoke('submitCleanupEvidence', { transactionRef: await f.ref(), grantRef: f.grant.grantRef,
    cleanupInstruction: instruction, review: f.review() }, f.auth);
  assert.equal(noOp.status, 'no-changes'); assert.equal(f.writes.length, 1);
  const advancing = await fixture(), livePreview = await advancing.prepare();
  advancing.beforeEffects = async () => { advancing.inputs.payload.fetchedAt =
    new Date(Date.parse(advancing.inputs.payload.fetchedAt) + 1000).toISOString(); };
  assert.equal((await advancing.service.invoke('applyStanding', { previewId: livePreview.previewId }, advancing.auth)).status,
    'applied', 'fresh GET timestamps must not invalidate an unchanged authorized target');
  const lateEffect = await fixture(), latePreview = await lateEffect.prepare(); let proofs = 0;
  lateEffect.beforeEffects = async () => { if (++proofs === 2) lateEffect.inputs.payload.tags.find(t=>t.id===33).name = 'Dale'; };
  assert.equal((await lateEffect.service.invoke('applyStanding', { previewId: latePreview.previewId }, lateEffect.auth)).status, 'unavailable');
  assert.equal(lateEffect.writes.length, 0, 'a newly disruptive final proof still refuses before dispatch');
  for (const mutate of [r => r.status = 'uncertain', r => r.issues.push('Ambiguous purchase'),
    r => r.facts.amount = '29', r => r.supportedChanges.payee = 'Other Cafe']) {
    const bad = await fixture(), review = bad.review(); mutate(review);
    assert.equal((await bad.service.invoke('submitCleanupEvidence', { transactionRef: await bad.ref(), grantRef: bad.grant.grantRef,
      cleanupInstruction: instruction, review }, bad.auth)).status, 'unavailable'); assert.equal(bad.writes.length, 0);
  }
  for (const body of [{ notes: 'Existing note\nAmanda personal' }, { additional_tag_ids: [44] }, { payee: 'ATM CASH WITHDRAWAL' }]) {
    const bad = household(), tx = bad.payload.transactions.find(t => t.id === 91004);
    assert.equal(E.evaluate({ inputs: bad, tx, body, parserRevision: 'synthetic' }).metadataNeutral, false, JSON.stringify(body));
  }
  for (const change of [x => x.payload.transactionWindow.complete = false, x => x.payload.pendingCoverage.complete = false,
    x => x.accountMap.mappings = [], x => x.payload.transactions.push(clone(x.payload.transactions.find(t=>t.id===91004))),
    x => x.payload.transactions.find(t=>t.id===91004).amount='30.0001',
    x => x.payload.transactions.find(t=>t.id===91004).amount='50000000000000000.01',
    x => { delete x.payload.transactions.find(t=>t.id===91004).notes; },
    x => { delete x.payload.transactions.find(t=>t.id===91004).category_id; },
    x => { delete x.payload.transactions.find(t=>t.id===91004).tag_ids; },
    x => { x.payload.tags = []; }, x => { x.payload.categories = []; }]) {
    const bad = household(); change(bad);
    assert.throws(() => E.evaluate({ inputs: bad, tx: bad.payload.transactions.find(t=>t.id===91004), body: {}, parserRevision: 'synthetic' }));
  }
  const changed = await fixture(), stale = await changed.prepare(); changed.tx.notes += '\nExternal note';
  assert.equal((await changed.service.invoke('applyStanding', { previewId: stale.previewId }, changed.auth)).status, 'unavailable');
  assert.equal(changed.writes.length, 0); assert.equal(changed.tx.notes, 'Existing note\nExternal note');
  const attachment = await fixture(), attachedPreview = await attachment.prepare();
  attachment.files.push({ name: 'Added attachment' });
  assert.equal((await attachment.service.invoke('applyStanding', { previewId: attachedPreview.previewId }, attachment.auth)).status, 'unavailable');
  assert.equal(attachment.writes.length, 0, 'the full by-ID fingerprint still rejects changed attachments before dispatch');
  const changedFiles = await fixture(), filesPreview = await changedFiles.prepare();
  changedFiles.afterWrite = () => changedFiles.files.push({ name: 'Unexpected attachment' });
  assert.equal((await changedFiles.service.invoke('applyStanding', { previewId: filesPreview.previewId }, changedFiles.auth)).status, 'write-unverified');
  assert.equal(changedFiles.writes.length, 1, 'an unexpected attachment readback is not silently accepted or retried');
  const lostTags = await fixture(false, nameOnly), lostTagsPreview = await lostTags.prepare();
  lostTags.afterWrite = () => { lostTags.inputs.payload.tags = []; };
  const lostTagsResult = await lostTags.service.invoke('applyStanding', { previewId: lostTagsPreview.previewId }, lostTags.auth);
  assert.equal(lostTagsResult.status, 'write-unverified', 'missing fresh tag labels cannot fall back to a hydrated cache as success');
  assert.deepEqual(lostTagsResult.auditReceipt.before.tags.map(t => t.name), ['Receipt']);
  assert.equal(lostTagsResult.auditReceipt.after, null, 'unavailable after evidence remains unknown');
  const badReadback = await fixture(), badPreview = await badReadback.prepare();
  badReadback.afterWrite = row => { row.amount = '31'; };
  const unverified = await badReadback.service.invoke('applyStanding', { previewId: badPreview.previewId }, badReadback.auth);
  assert.equal(unverified.status, 'write-unverified'); assert.equal(badReadback.grant.suspended, true);
  assert.equal(unverified.auditReceipt.after.amount, '31'); assert.equal(unverified.auditReceipt.before.amount, '30');
  assert.equal((await badReadback.service.invoke('applyStanding', { previewId: badPreview.previewId }, badReadback.auth)).status, 'unavailable');
  assert.equal(badReadback.writes.length, 1);
  const unsupported = await fixture(), unsupportedInstruction = { ...instruction, changes: { payee: 'Different permitted-looking name' } };
  assert.throws(() => C.grantShape(unsupported.grant, { ...unsupported.context, providerProof: { ...unsupported.context.providerProof, cleanupFields: undefined } },
    Date.parse(unsupported.inputs.payload.fetchedAt)), /provider-contract/);
  for (const payee of ['Transfer: Synthetic Bills → Synthetic Weekly', ' transfer : Bills → Weekly',
    'Ｔｒａｎｓｆｅｒ： Bills → Weekly', 'Transfer\u200b: Bills → Weekly']) {
    const misleading = { ...unsupported.grant, allowNotes: false,
      cleanupInstructions: [{ ...instruction, changes: { payee } }] };
    assert.throws(() => C.grantShape(misleading, unsupported.context, Date.parse(unsupported.inputs.payload.fetchedAt)),
      /transfer-label-requires-structured-evidence/, 'a generic name must not bypass the structured transfer proof');
  }
  const unsupportedReview = { ...unsupported.review(), supportedChanges: unsupportedInstruction.changes };
  assert.equal((await unsupported.service.invoke('submitCleanupEvidence', { transactionRef: await unsupported.ref(),
    grantRef: unsupported.grant.grantRef, cleanupInstruction: unsupportedInstruction, review: unsupportedReview }, unsupported.auth)).status, 'unavailable');
  for (const extra of [{ amount: '1' }, { splits: [] }, { delete: true }, { originalBankDescription: 'replacement' }, { notes: '' }]) {
    assert.equal((await unsupported.service.invoke('submitCleanupEvidence', { transactionRef: await unsupported.ref(),
      grantRef: unsupported.grant.grantRef, cleanupInstruction: { ...instruction, changes: { ...instruction.changes, ...extra } },
      review: unsupported.review() }, unsupported.auth)).status, 'unavailable');
  }
  const categoryInstruction = { ...instruction, name: 'Complete category receipt', changes: { categoryName: 'Gifts' } };
  const category = await fixture(false, categoryInstruction);
  category.grant.categoryTransitions = [{ from: 12, to: 13,
    fromSignature: P.categorySignature(category.inputs.payload.categories.find(c=>c.id===12)),
    toSignature: P.categorySignature(category.inputs.payload.categories.find(c=>c.id===13)) }];
  const catRef = (await category.service.invoke('catalog', {}, category.auth)).categories.find(c=>c.name==='Gifts').categoryRef;
  const oldReview = category.review;
  category.review = () => ({ ...oldReview(), categoryReceipt: { schema: P.DELEGATED_POLICY, status: 'resolved',
    sources: oldReview().sources, facts: { date: category.tx.date, payee: category.tx.payee, amount: '30', currency: 'cad',
      completeReceipt: true, items: [{ description: 'Synthetic gift purchase', amount: '30', categoryRef: catRef }] },
    rationale: 'Every receipt item is a gift.', issues: [] } });
  const cp = await category.prepare(); assert.equal(cp.status, 'preview', JSON.stringify(cp));
  assert.equal(cp.financialEffects.categoryEffect, 'authorized-category-reclassification');
  const categoryResult = await category.service.invoke('applyStanding', { previewId: cp.previewId }, category.auth);
  assert.equal(categoryResult.status, 'applied');
  assert.deepEqual(categoryResult.auditReceipt.before.tags.map(t => t.name), ['Receipt']);
  assert.deepEqual(categoryResult.auditReceipt.after.tags.map(t => t.name), ['Receipt']);
  assert.equal(category.tx.category_id, 13); assert.equal(category.tx.amount, '30');
  for (const name of ['Transfer', 'Payment']) {
    const danger = household(); danger.payload.categories.push({ id: 16, name, is_income: false,
      exclude_from_budget: false, exclude_from_totals: false });
    danger.data.plan = LmGroups.groupPlan(danger.data.plan);
    danger.payload = LmGroups.groupPayload(danger.payload, danger.data.plan);
    const proof = E.evaluate({ inputs: danger, tx: danger.payload.transactions.find(t=>t.id===91004),
      body: { category_id: 16 }, parserRevision: 'synthetic' });
    assert.equal(proof.metadataNeutral, true);
    assert.equal(proof.categoryEvidenceNeutral, false, 'same provider income/exclusion flags do not permit changed financial meaning');
  }
  const categoryUnsafe = await fixture(false, categoryInstruction);
  categoryUnsafe.inputs.payload.categories.find(c=>c.id===13).is_income = true;
  categoryUnsafe.grant.categoryTransitions = [{ from: 12, to: 13,
    fromSignature: P.categorySignature(categoryUnsafe.inputs.payload.categories.find(c=>c.id===12)),
    toSignature: P.categorySignature(categoryUnsafe.inputs.payload.categories.find(c=>c.id===13)) }];
  const unsafeRef = (await categoryUnsafe.service.invoke('catalog', {}, categoryUnsafe.auth)).categories.find(c=>c.name==='Gifts').categoryRef;
  assert.equal((await categoryUnsafe.service.invoke('submitCleanupEvidence', { transactionRef: await categoryUnsafe.ref(), grantRef: categoryUnsafe.grant.grantRef,
    cleanupInstruction: categoryInstruction, review: { ...categoryUnsafe.review(), categoryReceipt: { ...category.review().categoryReceipt,
      facts: { ...category.review().categoryReceipt.facts, items: [{ description: 'Synthetic gift', amount: '30', categoryRef: unsafeRef }] } } } }, categoryUnsafe.auth)).status, 'unavailable');
  const transferInstruction = { ...instruction, name: 'Verified bank transfer', changes: { transferLabel: {
    from: { name: 'Synthetic Bills', type: 'plaid' }, to: { name: 'Synthetic Weekly', type: 'plaid' } } } };
  const transfer = await fixture(false, transferInstruction);
  Object.assign(transfer.tx, { amount: '50', payee: 'RX456 TFR-TO', original_name: 'RX456 TFR-TO', category_id: 15 });
  const counterpart = { ...clone(transfer.tx), id: 91999, plaid_account_id: 1002, account_id: 1002,
    amount: '-50', payee: 'RX456 TFR-FR', original_name: 'RX456 TFR-FR' };
  transfer.inputs.payload.transactions.push(counterpart);
  const tp = await transfer.prepare(); assert.equal(tp.status, 'preview', JSON.stringify(tp));
  assert.equal((await transfer.service.invoke('applyStanding', { previewId: tp.previewId }, transfer.auth)).status, 'applied');
  assert.equal(transfer.tx.payee, 'Transfer: Synthetic Bills → Synthetic Weekly'); assert.equal(transfer.tx.original_name, 'RX456 TFR-TO');
  assert.equal(counterpart.payee, 'RX456 TFR-FR', 'only the exact selected leg is edited');
  const meta = { transfer: [{ type: 'plaid', id: 1001, name: 'Synthetic Bills' }, { type: 'plaid', id: 1002, name: 'Synthetic Weekly' }] };
  for (const mutation of [x=>x.transactions.push({ ...counterpart, id: 91998 }), x=>x.transactions.find(t=>t.id===91999).amount='-49',
    x=>x.transactions.find(t=>t.id===91999).is_pending=true, x=>x.transactions.find(t=>t.id===91999).original_name='ordinary deposit',
    x=>x.transactions.find(t=>t.id===91999).date='2026-08-17', x=>x.transactions.find(t=>t.id===91999).amount='-50.0001',
    x=>{ x.transactions.find(t=>t.id===91999).amount='-50000000000000000.02'; x.transactions.find(t=>t.id===91004).amount='50000000000000000.01'; }]) {
    const payload = clone(transfer.inputs.payload); mutation(payload);
    assert.throws(() => E.transferProof(payload, payload.transactions.find(t=>t.id===91004), meta));
  }
  const m = await fixture(), server = MCP.createServer(async () => null, { lunchMoney: m.service, auth: m.auth });
  const [ct, st] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'synthetic-routine', version: '1' });
  await server.connect(st); await client.connect(ct);
  try {
    assert.equal((await client.listTools()).tools.length, 13);
    const evidence = await client.callTool({ name: 'submit_lunchmoney_cleanup_evidence', arguments: { transactionRef: await m.ref(),
      grantRef: m.grant.grantRef, cleanupInstruction: instruction, review: m.review() } });
    assert.equal(evidence.structuredContent.status, 'evidence-recorded');
    const prepared = await client.callTool({ name: 'prepare_standing_lunchmoney_correction', arguments: { transactionRef: await m.ref(),
      grantRef: m.grant.grantRef, evidenceRef: evidence.structuredContent.evidenceRef, cleanupInstruction: instruction } });
    assert.equal(prepared.structuredContent.status, 'preview');
    const applied = await client.callTool({ name: 'apply_standing_lunchmoney_correction', arguments: { previewId: prepared.structuredContent.previewId } });
    assert.equal(applied.structuredContent.status, 'applied', JSON.stringify(applied));
  } finally { await client.close(); await server.close(); }
  if (process.platform !== 'win32') {
    for (const recipe of [instruction, nameOnly]) {
      const actual = await runtimeFixture(true, recipe);
      try {
        const p = await actual.prepare(); assert.equal(p.status, 'preview', JSON.stringify(p));
        actual.beforeEffects = async () => { actual.inputs.payload.fetchedAt = new Date(Date.parse(actual.inputs.payload.fetchedAt) + 1000).toISOString(); };
        const applied = await actual.service.invoke('applyStanding', { previewId: p.previewId }, actual.auth);
        assert.equal(applied.status, 'applied', JSON.stringify(applied));
        const restarted = S.createAuthority({ root: actual.root, publicKey: actual.publicKey, resource: actual.auth.resource,
          now: () => Date.parse(actual.inputs.payload.fetchedAt) });
        const audit = await restarted.audit({ grantRef: actual.grant.grantRef, auth: actual.auth });
        assert.equal(audit.length, 1); const row = audit[0].historyRow;
        assert.equal(row.outcome, 'applied'); assert.equal(row.before.notes, 'Existing note');
        assert.equal(row.after.notes, recipe.changes.notesAppend ? 'Existing note\nReceipt checked.' : 'Existing note');
        assert.equal(row.after.originalBankDescription, actual.tx.original_name);
        assert.deepEqual(row.before.tags.map(t => t.name), ['Receipt']);
        assert.deepEqual(row.proposed.tags.map(t => t.name), recipe.changes.tagNamesAdd ? ['Receipt', 'Checked'] : ['Receipt']);
        assert.deepEqual(row.after.tags.map(t => t.name).sort(), recipe.changes.tagNamesAdd ? ['Checked', 'Receipt'] : ['Receipt'],
          'fresh names persist through a private authority restart without the service reference cache');
        assert.equal(row.actor.clientId, actual.auth.clientId); assert.equal(row.sheetStatus, 'export-ready-not-synced');
        assert.equal(row.financialEffects.metadataNeutral, true); assert.equal(row.rowKey, audit[0].reservation.attemptRef);
        assert.deepEqual(row.financialEffects, applied.auditReceipt.financialEffects, 'final proof survives restart');
        assert.equal(row.financialEffects.categoryBefore, actual.runtime.proofs.at(-1).categoryBefore,
          'actual runtime final proof is committed with dispatch arming');
        assert.equal((await restarted.grant(actual.grant.grantRef)).suspended, false,
          'advancing runtime observations do not spuriously quarantine an acknowledged write');
        assert.notEqual(row.financialEffects.comparisons[0].before, p.financialEffects.comparisons[0].before,
          'history retains the last live proof, not the earlier preview observation');
        await assert.rejects(restarted.audit({ grantRef: actual.grant.grantRef, auth: { ...actual.auth, principal: 'other' } }));
      } finally { await actual.close(); }
    }
    const unsafe = await runtimeFixture(true);
    try {
      const preview = await unsafe.prepare(); assert.equal(preview.status, 'preview'); let proofs = 0;
      unsafe.beforeEffects = async () => {
        unsafe.inputs.payload.fetchedAt = new Date(Date.parse(unsafe.inputs.payload.fetchedAt) + 1000).toISOString();
        if (++proofs === 2) unsafe.inputs.payload.tags.find(t => t.id === 33).name = 'Dale';
      };
      const result = await unsafe.service.invoke('applyStanding', { previewId: preview.previewId }, unsafe.auth);
      assert.equal(result.status, 'unavailable'); assert.equal(unsafe.writes.length, 0);
      const restarted = S.createAuthority({ root: unsafe.root, publicKey: unsafe.publicKey, resource: unsafe.auth.resource,
        now: () => Date.parse(unsafe.inputs.payload.fetchedAt) });
      const rows = await restarted.audit({ grantRef: unsafe.grant.grantRef, auth: unsafe.auth });
      assert.equal(rows.length, 1); assert.equal(rows[0].historyRow.outcome, 'unavailable');
      assert.equal(rows[0].historyRow.after, null); assert.equal(rows[0].terminal.providerWriteMayHaveOccurred, false);
      assert.equal((await restarted.grant(unsafe.grant.grantRef)).suspended, true,
        'materially unsafe evidence under the lease stays durably unresolved instead of being retried');
    } finally { await unsafe.close(); }
  } else console.log('Actual durable routine authority proof requires POSIX; exercised by Linux CI.');
  console.log('Routine cleanup: real observer/overlay/Forecast, independent arithmetic, MCP standing apply without confirmation, preservation and sheet-ready history PASS');
}
module.exports = main();
module.exports.catch(e => { console.error(e); process.exitCode = 1; });
