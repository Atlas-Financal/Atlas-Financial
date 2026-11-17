'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const LM = require('../scripts/assistant-lunchmoney');
const Standing = require('../scripts/assistant-standing-corrections');
const OAuth = require('../scripts/assistant-oauth');
const MCP = require('../scripts/assistant-mcp');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
async function withMcp(lunchMoney, auth, work) {
  const server = MCP.createServer(async () => null, { lunchMoney, auth });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'synthetic-standing-contract', version: '1' });
  await server.connect(serverSide); await client.connect(clientSide);
  try { return await work(client); }
  finally { await client.close(); await server.close(); }
}
const hash = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const opaque = (type, n) => type + '-' + n.toString(16).padStart(24, '0');
function fixture(enabled = true, shared = { targets: new Map() }, grantNumber = 1) {
  let clock = Date.parse('2026-10-09T00:00:00Z');
  const token = 'synthetic-standing-test-token';
  const auth = { principal: 'synthetic-owner', clientId: 'synthetic-client',
    scopes: [LM.READ_SCOPE, LM.WRITE_SCOPE, Standing.SCOPE] };
  const tx = shared.tx || { id: 71, date: '2026-10-08', amount: '19.99', currency: 'cad', payee: 'Synthetic Shop',
    notes: 'Existing receipt reference', category_id: 3, plaid_account_id: 4, manual_account_id: null,
    is_pending: false, status: 'reviewed', tag_ids: [22] };
  shared.tx = tx;
  const categories = [{ id: 3, name: 'Groceries' }, { id: 8, name: 'Household' }];
  const context = { budgetRef: 'synthetic-budget', credentialVersion: 'synthetic-version', credentialDigest: hash(token), contextVersion: 'synthetic-context-v1', parserRevision: 'synthetic-v1', ruleEffects: 'none-verified' };
  const grant = { schema: 'atlas-standing-correction-grant/v1', grantRef: opaque('grant', grantNumber), revision: 1,
    principal: auth.principal, clientId: auth.clientId, ...Object.fromEntries(['budgetRef', 'credentialVersion', 'contextVersion', 'parserRevision'].map(k => [k, context[k]])),
    approvalRef: opaque('approval', 1), approvedByOwner: true, createdAt: clock, expiresAt: clock + 86400000,
    revokedAt: null, suspended: false, accounts: [{ type: 'plaid', id: 4 }], startDate: '2026-10-01', endDate: '2026-10-31',
    categoryTransitions: [{ from: 3, to: 8 }], allowNotes: true, evidencePolicy: 'synthetic-exact-receipt-v1',
    maxAttempts: 2, attempts: 0 };
  const state = { context, grant, tx, categories, writes: [], receipts: [], pending: false,
    evidence: null, hook: null, ambiguous: false, mismatch: false, mutateOther: false,
    auditFailure: false, missingActor: false, commitThenThrow: false, suspendFailure: false, ackCommitThenThrow: false, credentialChange: false, reserveFailure: false, notesEnabled: true, categorySensitive: false, verifyHook: null };
  const adapter = { durable: true,
    context: async () => structuredClone(context),
    grant: async ref => ref === grant.grantRef ? structuredClone(grant) : null,
    evidence: async ref => ref === state.evidence?.evidenceRef ? structuredClone(state.evidence) : null,
    // Synthetic effect evaluator, NOT the production observer adapter. Any
    // owner/classification effect is tested as rejection; production activation
    // still needs proof against the incumbent real map/plan/tags/parser.
    noteEffects: async (before, after) => {
      const effects = row => ({ personalOwner: /\bdale\b/i.test(row.notes) ? 'dale'
        : /\bamanda\b/i.test(row.notes) ? 'amanda' : null,
        fuel: /\bfuel\b/i.test(row.notes), resultingCategoryHint: state.categorySensitive && row.category_id === 8 && /\bmatched\b/i.test(row.notes), payment: /\bpayment\b/i.test(row.notes) });
      return { schema: 'atlas-standing-note-effects/v1', parserRevision: 'synthetic-v1',
        before: effects(before), after: effects(after) };
    },
    reserve: async attempt => {
      if (state.hook) await state.hook();
      if (state.reserveFailure || grant.revokedAt !== null || grant.suspended || state.pending
          || grant.expiresAt <= clock || attempt.expiresAt <= clock
          || grant.revision !== attempt.grantRevision || grant.attempts >= grant.maxAttempts
          || attempt.budgetRef !== context.budgetRef || attempt.credentialVersion !== context.credentialVersion
          || shared.targets.has(context.budgetRef + ':' + attempt.transactionId))
        throw new Error('synthetic-reservation-denied');
      // Atomic durable-store contract simulated: charge BEFORE provider attempt;
      // neither errors nor restarts refund this attempt.
      grant.attempts++; state.pending = true;
      const reservation = { attemptRef: opaque('attempt', grantNumber * 1000 + grant.attempts), grantRef: grant.grantRef,
        grantRevision: grant.revision, durable: true, authorized: true };
      shared.targets.set(context.budgetRef + ':' + attempt.transactionId, reservation.attemptRef);
      state.receipts.push({ ...structuredClone(attempt), reservation, outcome: 'pending' });
      return reservation;
    },
    verifyReservation: async attempt => {
      if (state.verifyHook) await state.verifyHook();
      const live = state.evidence;
      const valid = state.pending && shared.targets.get(context.budgetRef + ':' + attempt.transactionId) === attempt.reservation.attemptRef
        && grant.revokedAt === null && !grant.suspended && grant.revision === attempt.grantRevision
        && grant.expiresAt > clock && attempt.expiresAt > clock && live?.expiresAt > clock
        && live.grantRevision === grant.revision && live.resolution === 'resolved'
        && live.beforeFingerprint === attempt.beforeFingerprint && hash(live.body) === attempt.proposedFingerprint
        && attempt.contextVersion === context.contextVersion && attempt.contextVersion === grant.contextVersion
        && attempt.parserRevision === context.parserRevision && attempt.parserRevision === grant.parserRevision
        && live.contextVersion === context.contextVersion && live.parserRevision === context.parserRevision
        && attempt.budgetRef === context.budgetRef && attempt.credentialVersion === context.credentialVersion;
      return { valid, attemptRef: attempt.reservation.attemptRef };
    },
    suspend: async () => {
      if (state.suspendFailure) throw new Error('synthetic-suspension-unavailable');
      grant.suspended = true;
    },
    finish: async outcome => {
      if (state.auditFailure) throw new Error('synthetic-audit-failure');
      // Commit terminal data WITHOUT releasing the durable pending hold.
      if (outcome.outcome === 'write-unverified') grant.suspended = true;
      Object.assign(state.receipts.at(-1), structuredClone(outcome));
      state.terminal = structuredClone(outcome);
      if (state.commitThenThrow) throw new Error('synthetic-committed-reply-lost');
      return { receiptRef: opaque('receipt', grant.attempts), actorRef: state.missingActor ? null : opaque('actor', 1),
        durable: true, attemptRef: outcome.reservation.attemptRef, recordFingerprint: hash(outcome) };
    },
    acknowledgeVerified: async ack => {
      const receipt = state.receipts.at(-1);
      const terminal = state.terminal;
      if (grant.suspended || receipt.outcome !== 'applied' || receipt.verifiedByReadback !== true
          || ack.reservation.attemptRef !== receipt.reservation.attemptRef
          || ack.recordFingerprint !== hash(terminal)) throw new Error('synthetic-ack-rejected');
      state.pending = false;
      shared.targets.delete(context.budgetRef + ':' + receipt.transactionId);
      receipt.acknowledged = true;
      if (state.ackCommitThenThrow) throw new Error('synthetic-ack-reply-lost');
      return { acknowledged: true };
    },
  };
  const serviceOptions = { now: () => clock, env: {}, standingCorrections: { enabled, notesEnabled: state.notesEnabled, adapter },
    resolveToken: async () => state.credentialChange ? 'other-synthetic-token' : token,
    fetch: async (url, options) => {
      const u = new URL(url); const path = u.pathname.replace('/v2', ''); let data;
      if (options.method !== 'GET') {
        state.writes.push({ method: options.method, path, query: u.search, body: JSON.parse(options.body) });
        assert.equal(state.pending, true, 'durable reservation exists before provider write');
        if (state.ambiguous) throw new Error('synthetic-transport-failure');
        if (!state.mismatch) Object.assign(tx, JSON.parse(options.body));
        if (state.mutateOther) tx.tag_ids.push(33);
        data = tx;
      } else if (path === '/categories') data = { categories };
      else if (path.startsWith('/categories/')) data = categories.find(x => x.id === Number(path.split('/').pop()));
      else if (path === '/plaid_accounts') data = { plaid_accounts: [{ id: 4, name: 'Synthetic Bank' }] };
      else if (path === '/manual_accounts') data = { manual_accounts: [] };
      else if (path === '/transactions') data = { transactions: [tx], has_more: false };
      else data = tx;
      return { ok: true, json: async () => structuredClone(data) };
    },
  };
  const service = LM.createService(serviceOptions);
  async function proposal(body = { category_id: 8 }, clientService = service) {
    const cat = await clientService.invoke('catalog', {}, auth);
    const rows = await clientService.invoke('query', { startDate: '2026-10-01', endDate: '2026-10-31' }, auth);
    state.evidence = { schema: 'atlas-standing-correction-evidence/v1', evidenceRef: opaque('evidence', 1),
      grantRef: grant.grantRef, grantRevision: grant.revision, policy: grant.evidencePolicy,
      contextVersion: context.contextVersion, parserRevision: context.parserRevision,
      resolution: 'resolved', attestedBy: 'trusted-evidence-policy', expiresAt: clock + 86400000,
      transactionId: tx.id, beforeFingerprint: hash(tx), body: structuredClone(body) };
    return { transactionRef: rows.rows[0].transactionRef, grantRef: grant.grantRef, evidenceRef: state.evidence.evidenceRef,
      changes: { ...(body.category_id === undefined ? {} : { categoryRef: cat.categories.find(x => x.name === 'Household').categoryRef }),
        ...(body.notes === undefined ? {} : { notesAppend: body.notes.slice(tx.notes.length + 1) }) } };
  }
  return { ...state, state, adapter, service, auth, proposal, restart: () => LM.createService({ ...serviceOptions, standingCorrections: { ...serviceOptions.standingCorrections, notesEnabled: state.notesEnabled } }), clock: () => clock, advance: ms => { clock += ms; } };
}
async function deniedBeforeWrite(mutator, phase = 'prepare') {
  const f = fixture(); const args = await f.proposal();
  if (phase === 'prepare') {
    mutator(f);
    const result = await f.service.invoke('prepareStanding', args, f.auth);
    assert.equal(result.status, 'unavailable');
  } else {
    const preview = await f.service.invoke('prepareStanding', args, f.auth);
    assert.equal(preview.status, 'preview'); mutator(f);
    const result = await f.service.invoke('applyStanding', { previewId: preview.previewId }, f.auth);
    assert.equal(result.status, 'unavailable');
  }
  assert.equal(f.state.writes.length, 0); return f;
}
module.exports = (async () => {
  const f = fixture(); const args = await f.proposal();
  const preview = await f.service.invoke('prepareStanding', args, f.auth);
  assert.equal(preview.status, 'preview'); assert.equal(preview.authorization.mode, 'standing-grant');
  assert.equal(f.state.writes.length, 0);
  // The new path NEVER makes a false confirmed=true claim.
  const cross = await f.service.invoke('apply', { previewId: preview.previewId, confirmed: true }, f.auth);
  assert.equal(cross.reason, 'preview-authorization-mode-mismatch');
  const result = await f.service.invoke('applyStanding', { previewId: preview.previewId }, f.auth);
  assert.equal(result.status, 'applied'); assert.equal(result.verifiedByReadback, true);
  assert.deepEqual(f.state.writes, [{ method: 'PUT', path: '/transactions/71', query: '?update_balance=false', body: { category_id: 8 } }]);
  assert.equal(f.tx.amount, '19.99'); assert.equal(f.tx.notes, 'Existing receipt reference');
  assert.equal(result.auditReceipt.before.category, 'Groceries'); assert.equal(result.auditReceipt.after.category, 'Household');
  assert.equal(result.auditReceipt.grantRef, f.grant.grantRef); assert.equal(result.auditReceipt.evidenceRef, args.evidenceRef);
  assert.match(result.auditReceipt.actorRef, /^actor-/); assert.equal(f.state.receipts[0].outcome, 'applied');
  await f.service.invoke('applyStanding', { previewId: preview.previewId }, f.auth);
  assert.equal(f.state.writes.length, 1, 'single use');
  const limited = fixture(); limited.grant.maxAttempts = 1;
  const la = await limited.proposal(); const lp = await limited.service.invoke('prepareStanding', la, limited.auth);
  assert.equal((await limited.service.invoke('applyStanding', { previewId: lp.previewId }, limited.auth)).status, 'applied');
  limited.tx.id = 72; limited.tx.category_id = 3;
  const secondArgs = await limited.proposal();
  assert.equal((await limited.service.invoke('prepareStanding', secondArgs, limited.auth)).status, 'unavailable');
  assert.equal(limited.state.writes.length, 1, 'attempt ceiling survives a new target/preview');
  const off = fixture(false); const offArgs = await off.proposal();
  assert.equal(off.service.standingEnabled, false);
  assert.equal((await off.service.invoke('prepareStanding', offArgs, off.auth)).reason, 'standing-corrections-disabled');
  const absent = LM.createService({ standingCorrections: { enabled: true, adapter: {} } });
  assert.equal(absent.standingEnabled, false, 'flag alone grants nothing');
  for (const scope of [LM.READ_SCOPE, LM.WRITE_SCOPE, Standing.SCOPE]) {
    await deniedBeforeWrite(x => { x.auth.scopes = x.auth.scopes.filter(s => s !== scope); });
  }
  for (const mutation of [
    x => { x.auth.principal = 'other-owner'; }, x => { x.auth.clientId = 'other-client'; },
    x => { x.auth.clientId = 'oauth-client'; }, x => { x.grant.approvedByOwner = false; },
    x => { x.grant.revokedAt = x.clock(); }, x => { x.grant.expiresAt = x.clock(); },
    x => { x.grant.expiresAt = x.clock() + Standing.MAX_GRANT_MS + 1; },
    x => { x.grant.attempts = x.grant.maxAttempts; }, x => { x.grant.maxAttempts = 0; },
    x => { x.grant.accounts = [{ type: 'manual', id: 4 }]; }, x => { x.grant.startDate = '2026-10-09'; },
    x => { x.grant.categoryTransitions = [{ from: 8, to: 3 }]; },
    x => { x.state.context.budgetRef = 'other-budget'; },
    x => { x.state.context.ruleEffects = 'unknown'; },
    x => { x.state.context.credentialVersion = 'other-version'; },
    x => { x.state.context.contextVersion = 'other-context'; },
    x => { x.state.context.parserRevision = 'other-parser'; },
    x => { x.state.evidence.contextVersion = 'other-context'; },
    x => { x.state.evidence.parserRevision = 'other-parser'; },
    x => { x.state.evidence.resolution = 'uncertain'; },
    x => { x.state.evidence.attestedBy = 'model-confidence'; },
    x => { x.state.evidence.beforeFingerprint = 'invented'; },
    x => { x.state.evidence.body = { amount: '1.00' }; },
    x => { x.state.evidence.grantRevision++; },
    x => { x.tx.is_pending = true; }, x => { x.tx.is_group_parent = true; },
    x => { x.tx.split_parent_id = 99; }, x => { x.tx.status = 'deleted_pending'; },
  ]) await deniedBeforeWrite(mutation);
  for (const mutation of [
    x => { x.grant.revokedAt = x.clock(); }, x => { x.grant.revision++; },
    x => { x.grant.expiresAt = x.clock(); },
    x => { x.auth.scopes = x.auth.scopes.filter(s => s !== Standing.SCOPE); },
    x => { x.state.evidence.resolution = 'uncertain'; },
    x => { x.state.context.budgetRef = 'changed-budget'; },
    x => { x.advance(LM.TTL + 1); }, x => { x.tx.notes += ' changed elsewhere'; },
    x => { x.categories[1].archived = true; }, x => { x.state.credentialChange = true; },
    x => { x.state.hook = () => { x.grant.revokedAt = x.clock(); }; },
    x => { x.state.hook = () => { x.grant.attempts = x.grant.maxAttempts; }; },
    x => { x.state.reserveFailure = true; },
    x => { x.state.hook = () => { x.tx.notes += ' changed after reservation'; }; },
    x => { x.state.verifyHook = () => { x.state.evidence.expiresAt = x.clock(); }; },
    x => { x.state.verifyHook = () => { x.state.context.contextVersion = 'new-context'; }; },
    x => { x.state.verifyHook = () => { x.state.context.parserRevision = 'new-parser'; }; },
    x => { x.state.verifyHook = () => { x.grant.revokedAt = x.clock(); }; },
  ]) await deniedBeforeWrite(mutation, 'apply');
  const note = fixture(); const noteArgs = await note.proposal({ notes: note.tx.notes + '\nReceipt matched synthetic order' });
  const np = await note.service.invoke('prepareStanding', noteArgs, note.auth);
  assert.equal(np.status, 'preview');
  assert.equal((await note.service.invoke('applyStanding', { previewId: np.previewId }, note.auth)).status, 'applied');
  assert.equal(note.tx.category_id, 3); assert.equal(note.tx.notes, 'Existing receipt reference\nReceipt matched synthetic order');
  const categoryOnly = fixture(); categoryOnly.state.notesEnabled = false;
  const categoriesService = categoryOnly.restart();
  const coa = await categoryOnly.proposal({ category_id: 8 }, categoriesService);
  const cop = await categoriesService.invoke('prepareStanding', coa, categoryOnly.auth);
  assert.equal(cop.status, 'preview', 'category-only eligibility needs no note parser opt-in');
  const cna = await categoryOnly.proposal({ notes: categoryOnly.tx.notes + '\nSynthetic receipt' }, categoriesService);
  assert.equal((await categoriesService.invoke('prepareStanding', cna, categoryOnly.auth)).status, 'unavailable', 'notes stay separately default off');
  const combined = fixture(); const ca = await combined.proposal({ category_id: 8, notes: combined.tx.notes + '\nReceipt matched synthetic order' });
  const cp = await combined.service.invoke('prepareStanding', ca, combined.auth);
  assert.equal((await combined.service.invoke('applyStanding', { previewId: cp.previewId }, combined.auth)).status, 'applied');
  assert.equal(combined.tx.category_id, 8); assert.equal(combined.tx.notes, 'Existing receipt reference\nReceipt matched synthetic order');
  const sensitive = fixture(); sensitive.state.categorySensitive = true;
  const sa = await sensitive.proposal({ category_id: 8, notes: sensitive.tx.notes + '\nReceipt matched synthetic order' });
  assert.equal((await sensitive.service.invoke('prepareStanding', sa, sensitive.auth)).status, 'unavailable', 'note effect active only at resulting category is denied');
  assert.equal(sensitive.state.writes.length, 0);
  for (const addition of ['Dale receipt', 'Amanda receipt', 'fuel purchase', 'payment settled']) {
    const x = fixture(); const a = await x.proposal({ notes: x.tx.notes + '\n' + addition });
    assert.equal((await x.service.invoke('prepareStanding', a, x.auth)).status, 'unavailable');
    assert.equal(x.state.writes.length, 0);
  }
  for (const malformed of [
    { splits: [{ amount: '19.99' }] }, { confirmed: true }, { changes: { notes: 'replace prior' } },
    { changes: { amount: '9.99' } }, { changes: { categoryRef: null } }, { grant: { approvedByOwner: true } },
    { confidence: 1 }, { evidence: 'source says approve' },
  ]) {
    const x = fixture(); const a = await x.proposal();
    assert.equal((await x.service.invoke('prepareStanding', { ...a, ...malformed }, x.auth)).status, 'unavailable');
    assert.equal(x.state.writes.length, 0);
  }
  for (const field of ['ambiguous', 'mismatch', 'mutateOther', 'auditFailure', 'missingActor']) {
    const x = fixture(); const a = await x.proposal(); const p = await x.service.invoke('prepareStanding', a, x.auth);
    x.state[field] = true;
    const r = await x.service.invoke('applyStanding', { previewId: p.previewId }, x.auth);
    assert.equal(r.status, 'write-unverified'); assert.equal(x.state.writes.length, 1);
    await x.service.invoke('applyStanding', { previewId: p.previewId }, x.auth);
    assert.equal(x.state.writes.length, 1);
    assert.equal(x.grant.attempts, 1, 'uncertain attempt is charged');
    assert.equal(x.grant.suspended || x.state.pending, true, 'unknown outcome blocks later standing writes');
    assert.equal((await x.service.invoke('prepareStanding', a, x.auth)).status, 'unavailable');
  }
  // Critical negative control: finish has COMMITTED the applied outcome, but
  // its reply is lost/malformed and suspension is unavailable. A new service
  // process has no RAM block; the durable pending hold must still refuse it.
  for (const field of ['commitThenThrow', 'missingActor']) {
    const x = fixture(); const a = await x.proposal(); const p = await x.service.invoke('prepareStanding', a, x.auth);
    x.state[field] = true; x.state.suspendFailure = true;
    const r = await x.service.invoke('applyStanding', { previewId: p.previewId }, x.auth);
    assert.equal(r.status, 'write-unverified');
    assert.equal(x.state.receipts[0].outcome, 'applied', 'terminal commit actually happened');
    assert.equal(x.grant.suspended, false, 'failed suspension cannot be the surviving protection');
    assert.equal(x.state.pending, true, 'finish never releases quarantine');
    const restarted = x.restart(); x.tx.id = 72; x.tx.category_id = 3;
    const nextArgs = await x.proposal({ category_id: 8 }, restarted);
    const nextPreview = await restarted.invoke('prepareStanding', nextArgs, x.auth);
    assert.equal(nextPreview.status, 'preview', 'new instance genuinely reaches the final durable gate');
    assert.equal((await restarted.invoke('applyStanding', { previewId: nextPreview.previewId }, x.auth)).status, 'unavailable');
    assert.equal(x.state.writes.length, 1, 'restart cannot escape the durable quarantine');
  }
  // A lost ACK reply occurs only after known readback + validated durable audit.
  // The edit stays honestly applied; only future-grant continuation is unknown.
  const ackLost = fixture(); const aa = await ackLost.proposal();
  const ap = await ackLost.service.invoke('prepareStanding', aa, ackLost.auth);
  ackLost.state.ackCommitThenThrow = true;
  const ar = await ackLost.service.invoke('applyStanding', { previewId: ap.previewId }, ackLost.auth);
  assert.equal(ar.status, 'applied'); assert.equal(ar.verifiedByReadback, true);
  assert.match(ar.standingGrantContinuation, /acknowledgment-unconfirmed/);
  assert.equal(ackLost.state.receipts[0].acknowledged, true);
  assert.equal(ackLost.state.writes.length, 1);
  await ackLost.service.invoke('applyStanding', { previewId: ap.previewId }, ackLost.auth);
  assert.equal(ackLost.state.writes.length, 1);
  const race = fixture(); const ra = await race.proposal();
  const rp = await race.service.invoke('prepareStanding', ra, race.auth);
  const rr = await Promise.all([1, 2].map(() => race.service.invoke('applyStanding', { previewId: rp.previewId }, race.auth)));
  assert.equal(rr.filter(x => x.status === 'applied').length, 1); assert.equal(race.state.writes.length, 1);
  // Two previews for a single target still share the incumbent process lock.
  const tw = fixture(); const ta = await tw.proposal();
  const tp = await Promise.all([1, 2].map(() => tw.service.invoke('prepareStanding', ta, tw.auth)));
  const tr = await Promise.all(tp.map(p => tw.service.invoke('applyStanding', { previewId: p.previewId }, tw.auth)));
  assert.equal(tr.filter(x => x.status === 'applied').length, 1); assert.equal(tw.state.writes.length, 1);
  // Separate service instances and overlapping grants share the target lease.
  const shared = { targets: new Map() }; const one = fixture(true, shared, 1); const two = fixture(true, shared, 2);
  const oa = await one.proposal(); const ob = await two.proposal();
  const op = await one.service.invoke('prepareStanding', oa, one.auth);
  const oq = await two.service.invoke('prepareStanding', ob, two.auth);
  const sharedResults = await Promise.all([
    one.service.invoke('applyStanding', { previewId: op.previewId }, one.auth),
    two.service.invoke('applyStanding', { previewId: oq.previewId }, two.auth),
  ]);
  assert.equal(sharedResults.filter(r => r.status === 'applied').length, 1);
  assert.equal(one.state.writes.length + two.state.writes.length, 1, 'one target cannot be edited concurrently under overlapping grants');
  // Force a second instance's successful edit between another instance's GET
  // and durable reserve. The second read after reservation must catch it.
  const delayedShared = { targets: new Map() }; const delayed = fixture(true, delayedShared, 1); const winner = fixture(true, delayedShared, 2);
  const da = await delayed.proposal(); const wb = await winner.proposal();
  const dp = await delayed.service.invoke('prepareStanding', da, delayed.auth);
  const wp = await winner.service.invoke('prepareStanding', wb, winner.auth);
  delayed.state.hook = async () => {
    assert.equal((await winner.service.invoke('applyStanding', { previewId: wp.previewId }, winner.auth)).status, 'applied');
  };
  assert.equal((await delayed.service.invoke('applyStanding', { previewId: dp.previewId }, delayed.auth)).status, 'unavailable');
  assert.equal(delayed.state.writes.length, 0); assert.equal(winner.state.writes.length, 1);
  // Interactive previews cannot be applied by standing operations.
  const interactive = fixture(false); const ia = await interactive.proposal();
  const ip = await interactive.service.invoke('prepare', { transactionRef: ia.transactionRef,
    changes: { notes: 'Interactive exact preview' } }, interactive.auth);
  assert.equal((await interactive.service.invoke('applyStanding', { previewId: ip.previewId }, interactive.auth)).reason, 'preview-authorization-mode-mismatch');
  assert.equal((await interactive.service.invoke('apply', { previewId: ip.previewId, confirmed: false }, interactive.auth)).reason, 'invalid-arguments');
  // Existing standalone confirmed-edit suite proves the interactive write.
  const config = { configured: true, requiredScope: 'atlas.current.read', resource: new URL('https://atlas.example/assistant/mcp'),
    issuer: 'https://issuer.example', metadataUrl: 'https://atlas.example/.well-known/oauth-protected-resource' };
  const call = name => ({ method: 'tools/call', params: { name } });
  assert.equal(OAuth.protectedResourceMetadata(config).scopes_supported.includes(Standing.SCOPE), false);
  assert.equal(OAuth.classifyToolCalls(call('apply_standing_lunchmoney_correction')), 'other');
  assert.equal(OAuth.classifyToolCalls(call('apply_standing_lunchmoney_correction'), true), 'standing');
  assert.equal(OAuth.classifyToolCalls([call('apply_standing_lunchmoney_correction'), call('apply_lunchmoney_edit')], true), 'standing');
  const opted = { ...config, standingCorrectionsEnabled: true };
  assert.equal(OAuth.protectedResourceMetadata(opted).scopes_supported.includes(Standing.SCOPE), true);
  assert.equal(OAuth.writeStepUpChallenge(config).includes(Standing.SCOPE), false);
  assert.equal(OAuth.writeStepUpChallenge(opted, true).includes(Standing.SCOPE), true);
  assert.equal(OAuth.CHALLENGE_SCOPES.includes(Standing.SCOPE), false);
  let next = 0; let status = null; let challenge = null;
  const res = { status: n => { status = n; return res; }, json: x => x,
    setHeader: (_, value) => { challenge = value; } };
  OAuth.createWriteStepUp(opted)({ body: call('apply_standing_lunchmoney_correction'),
    auth: { scopes: [LM.READ_SCOPE, LM.WRITE_SCOPE] } }, res, () => { next++; });
  assert.equal(status, 403); assert.match(challenge, /correct-with-grant/); assert.equal(next, 0);
  await withMcp(off.service, off.auth, async client => {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 8);
    assert.equal(listed.tools.some(x => /standing/.test(x.name)), false, 'default tool contract exposes no standing authority');
    const interactiveApply = listed.tools.find(x => x.name === 'apply_lunchmoney_edit');
    assert.equal(interactiveApply.inputSchema.required.includes('confirmed'), true);
  });
  const verifiedReq = { auth: { extra: { subject: 'verified-subject' }, clientId: 'verified-client',
    scopes: [LM.READ_SCOPE] }, body: { auth: { principal: 'forged-owner', clientId: 'forged-client',
    scopes: [LM.WRITE_SCOPE, Standing.SCOPE] } } };
  assert.deepEqual(MCP.authFromVerifiedRequest(verifiedReq), {
    principal: 'verified-subject', clientId: 'verified-client', resource: undefined, scopes: [LM.READ_SCOPE] });
  assert.deepEqual(MCP.authFromVerifiedRequest({ body: verifiedReq.body }), {
    principal: undefined, clientId: undefined, resource: undefined, scopes: [] });
  let invoked = 0;
  await withMcp({ standingEnabled: true, invoke: async () => { invoked++; throw new Error('must not dispatch'); } },
    { ...f.auth, scopes: [LM.READ_SCOPE, LM.WRITE_SCOPE] }, async client => {
      const denied = await client.callTool({ name: 'apply_standing_lunchmoney_correction',
        arguments: { previewId: 'edit-' + 'a'.repeat(48) } });
      assert.equal(denied.isError, true);
      assert.equal(denied.structuredContent.reason, 'standing-correction-scopes-required');
    });
  assert.equal(invoked, 0, 'MCP scope gate refuses before service/provider dispatch');
  const wired = fixture(); const wa = await wired.proposal();
  await withMcp(wired.service, wired.auth, async client => {
    const listed = await client.listTools(); assert.equal(listed.tools.length, 10);
    const descriptor = listed.tools.find(x => x.name === 'apply_standing_lunchmoney_correction');
    assert.deepEqual(descriptor._meta.securitySchemes[0].scopes,
      [MCP.REQUIRED_SCOPE, LM.READ_SCOPE, LM.WRITE_SCOPE, Standing.SCOPE]);
    assert.equal(descriptor.annotations.readOnlyHint, false);
    assert.equal(descriptor.annotations.idempotentHint, false);
    assert.equal(Object.hasOwn(descriptor.inputSchema.properties, 'confirmed'), false);
    const p = await client.callTool({ name: 'prepare_standing_lunchmoney_correction', arguments: wa });
    assert.equal(p.structuredContent.status, 'preview'); assert.equal(wired.state.writes.length, 0);
    const r = await client.callTool({ name: 'apply_standing_lunchmoney_correction',
      arguments: { previewId: p.structuredContent.previewId } });
    assert.equal(r.structuredContent.status, 'applied'); assert.match(r.structuredContent.auditReceipt.receiptRef, /^receipt-/);
    assert.equal(wired.state.writes.length, 1);
  });
  console.log('Standing corrections: default off, exact scope/grant/evidence binding, revocation/limits, notes effects, audit, stale/replay/races and unchanged interactive contract PASS');
})().then(() => require('./test-assistant-standing-store')).catch(error => { console.error(error); process.exitCode = 1; });
