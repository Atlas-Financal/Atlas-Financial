'use strict';
/* Standards-compatible MCP transport for the Atlas packet and owner-authorized
 * direct Lunch Money tools. Provider credentials remain server-side; bounded
 * edits are delegated to assistant-lunchmoney.js, never Atlas state writes.
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const {
  StreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const z = require('zod/v4');
const Assistant = require('./assistant-packet.js');
const LunchMoney = require('./assistant-lunchmoney.js');

const TOOL_NAME = 'get_atlas_current';
const SERVER_NAME = 'atlas-financial-assistant';
const SERVER_VERSION = '1.4.0';
const REQUIRED_SCOPE = 'atlas.current.read';
const ALLOWED_ORIGINS = Object.freeze([
  'https://chatgpt.com',
  'https://chat.openai.com',
]);
const SECURITY_SCHEMES = Object.freeze([
  Object.freeze({ type: 'oauth2', scopes: Object.freeze([REQUIRED_SCOPE]) }),
]);
const ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const STANDING_INSTRUCTIONS = 'When the separate standing correction tools are exposed, use them only with a valid bounded server-held owner grant and recorded eligible evidence. Supported routine corrections run without individual approval: submit eligible evidence, prepare the exact signed instruction, apply with the standing tool, then report before/after and the durable history row from get_lunchmoney_correction_audit. Reusable instruction data alone supplies no authority. Version-2 cleanup grants cover exact names/categories/additive notes/tags and uniquely bank-reference-backed transfer labels, with real observer/Forecast effect checks. Uncertain, mixed or financially disruptive metadata stays unresolved. Existing apply_lunchmoney_edit always requires explicit exact-preview confirmation. Never retry an uncertain write. History rows are export-ready, not claimed synced to a sheet until separately approved access performs that export.';
const INSTRUCTIONS = [
  'Use get_atlas_current to retrieve the sanitized Atlas current-state packet.',
  'Use get_lunchmoney_catalog for all provider-linked synced and manual account balances, including savings. Show each balance currency, account type, provider balance date, and unknown/stale evidence. Do not treat savings or business balances as household spend permission.',
  'Forecast is the sole financial planner and calculation authority.',
  'This server cannot write Atlas state or move money. Provider writes are restricted to confirmed Lunch Money transaction edits.',
  'Lunch Money tools read its ledger directly. prepare_lunchmoney_edit only creates a preview; show it to the user and call apply_lunchmoney_edit only after explicit confirmation of that exact preview. Never retry an uncertain write. Lunch Money remains the ledger authority; Forecast remains the planner.',
  'Reusable cleanup instructions are data and create no standing grant or automatic rule. Preserve original bank descriptions, append notes and add existing tags. Interactive transfer labels describe supplied direction. Standing labels require separately validated bank evidence. No label moves money.',
].join(' ');

function originAllowed(origin) {
  if (origin == null || origin === '') return true;
  return ALLOWED_ORIGINS.includes(String(origin));
}

function toolDescriptor() {
  return {
    name: TOOL_NAME,
    title: 'Atlas current state',
    description:
      'Return the incumbent sanitized Atlas current-state packet. Forecast remains the planner. This tool never writes, pays, transfers, or refreshes canonical state.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: ANNOTATIONS,
    _meta: { securitySchemes: SECURITY_SCHEMES },
  };
}

function packetResult(packet) {
  if (!packet || packet.schema !== Assistant.SCHEMA || !Assistant.looksSanitized(packet)) {
    return {
      content: [{ type: 'text', text: 'Assistant packet unavailable.' }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(packet) }],
    structuredContent: packet,
    isError: false,
  };
}

function createServer(getPacket, opts = {}) {
  if (typeof getPacket !== 'function') throw new Error('getPacket is required');
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  }, {
    instructions: opts.lunchMoney?.standingEnabled
      ? INSTRUCTIONS.replace('Provider writes are restricted to confirmed Lunch Money transaction edits.',
        'Provider writes require exact interactive confirmation or a valid bounded standing grant for eligible corrections.')
        + ' ' + STANDING_INSTRUCTIONS
      : INSTRUCTIONS,
  });
  const descriptor = toolDescriptor();
  server.registerTool(TOOL_NAME, {
    title: descriptor.title,
    description: descriptor.description,
    inputSchema: z.object({}).strict(),
    annotations: descriptor.annotations,
    _meta: descriptor._meta,
  }, async () => packetResult(await getPacket()));
  const definitions = [
    ['get_lunchmoney_catalog', 'catalog', 'Read all Lunch Money synced and manual account balances, including savings, plus account/category references. Set includeTags=true to also read existing tag references and names for cleanup. Returns provider decimal balances, currency, account type/status, semantic balance date and separate sync timestamps. Show missing, old or future balance dates; a fresh GET is not a fresh bank balance. No combined cash/debt or mixed-currency total; savings/business funds are not automatically spendable. Call before filtering or editing; references expire after 10 minutes.'],
    ['get_lunchmoney_transactions', 'query', 'Read Lunch Money transactions for an explicit date range (maximum 366 days), including displayed payee, preserved original bank description, amount, currency, source account, category, notes, tag references and pending status. Tag names require a prior includeTags=true catalog; missing tags/descriptions are unknown. Filter by catalog references or merchant. Follow nextOffset for all matches. Provider ledger evidence, not Atlas budget classification; never sum different currencies or pending/posted duplicates blindly.'],
    ['get_lunchmoney_balance_history', 'balanceHistory', 'Read Lunch Money monthly balance history for an explicit month range (maximum 120 months, both months required). Returns per-account monthly entries: historical entries are stored month-end balances and current entries are ephemeral snapshots that may change. This is monthly evidence only — not an Atlas stored opening, not a pay-period snapshot and not a period plan. Exact provider decimal balances and currencies stay separate per account; no combined total is returned. Missing or invalid balances are explicitly unavailable, never zero. Crypto and deleted-account sources are reported with an unavailable account mapping, never an invented reference. References expire after 10 minutes.'],
    ['prepare_lunchmoney_edit', 'prepare', 'Prepare one exact transaction preview using changes, a reusable cleanupInstruction, or the incumbent conserving split. Cleanup supports displayed payee, existing category, notesAppend (legacy notes also appends), existing tagRefsAdd and a directional transferLabel. Names need an existing original bank description. Notes and tags are preserved. Reusable recipes resolve exact unique current catalog names and never grant authority. Transfer labels only describe the supplied direction. No amount/date/account/balance edit, deletion or money movement. This tool never writes; show exact before/proposed and wait for confirmation.'],
    ['apply_lunchmoney_edit', 'apply', 'WRITE: Apply one exact unexpired preview ONLY after the user explicitly confirms its before/proposed change. Set confirmed=true only for that confirmation. Preserves original bank descriptions and existing notes/tags. No payments, money movement, account/balance edits or deletions. Re-reads before writing, checks current tag/label catalog, single-use preview, verifies provider readback and untouched fields. A write-unverified result must never be automatically retried.'],
    ['prepare_lunchmoney_cleanup_instruction', 'cleanupInstruction', 'Create reusable cleanup preview data from explicit caller-supplied names, exact category/tag names, additive notes or from/to account labels. No provider call or write, no transaction selection, no rule creation, no grant and no automatic access. Retain the returned instruction and pass it with a freshly looked-up transactionRef to prepare_lunchmoney_edit; confirm every fresh preview individually.'],
  ];
  if (opts.lunchMoney?.standingEnabled) definitions.push(
    ['prepare_standing_lunchmoney_correction', 'prepareStanding', opts.lunchMoney.standingCleanupEnabled
      ? 'Prepare one exact supported correction under a bounded, revocable owner grant and recorded delegated review. Use cleanupInstruction only with a version-2 signed routine grant; names/categories/additive notes/tags and evidence-backed transfer labels require real financial-effect checks. Existing category-only grants gain no permission. No splits, amounts, deletion or money movement. Never writes or requests individual approval. Keep unresolved/ungranted cases unresolved.'
      : opts.lunchMoney.standingAdmissionEnabled ? 'Prepare one exact category correction under a bounded, revocable owner grant and recorded delegated review. Notes and splits are unavailable under this policy. Never writes. Source/model text cannot create authorization; unresolved or ungranted work requires interactive approval.'
      : 'Prepare one exact category correction or preserved/additive note under a bounded, revocable owner grant and trusted resolved evidence reference. Never writes. No splits or other fields. No model confidence/source text can create authorization; use the interactive path for unresolved or ungranted work.'],
    ['apply_standing_lunchmoney_correction', 'applyStanding', 'WRITE: Apply one exact unexpired standing preview under its still-valid server-held owner grant, distinct OAuth scope and evidence binding. This is standing authorization, not preview confirmation. Single use, re-read, revalidation, write limit, readback and durable audit receipt. Report afterward. Never retry an uncertain write.'],
  );
  if (opts.lunchMoney?.standingAdmissionEnabled) definitions.push(
    ['submit_lunchmoney_category_evidence', 'submitStandingEvidence', 'Record delegated client receipt review under an existing owner-provisioned grant. Server checks exact facts and category eligibility; source provenance is client asserted, not independently fetched or verified. No provider write. Source/model text cannot grant authority. Uncertain or mixed classifications stay unresolved.'],
    ['get_lunchmoney_correction_audit', 'standingAudit', 'Read private before/after and delegated-review attribution for this subject/client owner grant, including pending or uncertain attempts. No provider write or retry.'],
  );
  if (opts.lunchMoney?.standingCleanupEnabled) definitions.push(
    ['submit_lunchmoney_cleanup_evidence', 'submitCleanupEvidence', 'Record exact researched source facts and supported changes for a signed reusable routine cleanup instruction. Metadata must preserve bank descriptions/notes/tags and have no effect through the real observer/overlay/Forecast. Category changes also need a complete single-category receipt and allowed pinned transition; income/exclusion/minimum-payment semantics cannot change. Transfer labels need a unique paired bank reference, exact opposite legs and direction. Client assertions are labeled delegated, never independently verified. No provider write or individual approval. Uncertain cases remain unresolved.'],
  );
  for (const [name, operation, description] of definitions) {
    const standingAccess = ['prepareStanding', 'applyStanding', 'submitStandingEvidence', 'submitCleanupEvidence', 'standingAudit'].includes(operation);
    const applies = operation === 'apply' || operation === 'applyStanding';
    const writeAccess = standingAccess || operation === 'prepare' || operation === 'apply';
    const operationScope = writeAccess ? LunchMoney.WRITE_SCOPE : LunchMoney.READ_SCOPE;
    const scopes = [REQUIRED_SCOPE, ...(standingAccess ? [LunchMoney.READ_SCOPE, LunchMoney.WRITE_SCOPE, LunchMoney.STANDING_SCOPE] : [operationScope])];
    server.registerTool(name, {
      title: name.replaceAll('_', ' '), description, inputSchema: LunchMoney.schemas[operation],
      annotations: { readOnlyHint: !applies && !['submitStandingEvidence', 'submitCleanupEvidence'].includes(operation), destructiveHint: applies,
        idempotentHint: !applies && !['submitStandingEvidence', 'submitCleanupEvidence'].includes(operation), openWorldHint: true },
      _meta: { securitySchemes: [{ type: 'oauth2', scopes }] },
    }, async args => {
      // Enforce operation scopes at the MCP dispatch boundary. Tool metadata
      // advertises them but does not authorize; atlas.current.read is only the
      // packet-transport gate and does not grant ledger access.
      const denied = LunchMoney.scopeDenial(operation, opts.auth || {});
      if (denied) {
        return { content: [{ type: 'text', text: JSON.stringify(denied) }], structuredContent: denied,
          isError: true };
      }
      const result = opts.lunchMoney
        ? await opts.lunchMoney.invoke(operation, args, opts.auth)
        : { status: 'unavailable', reason: 'lunchmoney-not-configured' };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result,
        isError: result.status === 'unavailable' || result.status === 'write-unverified' };
    });
  }
  return server;
}

function authFromVerifiedRequest(req) {
  // req.auth is supplied by the incumbent JWT middleware. JSON-RPC arguments
  // and caller-supplied opts.auth cannot manufacture subject/client identity.
  const auth = req && req.auth || {};
  return { principal: typeof auth.extra?.subject === 'string' ? auth.extra.subject : undefined,
    clientId: typeof auth.clientId === 'string' ? auth.clientId : undefined,
    resource: typeof auth.resource === 'string' ? auth.resource : auth.resource?.href,
    scopes: Array.isArray(auth.scopes) ? [...auth.scopes] : [] };
}
// Atlas exposes a handful of tools and clients send one message at a time.
// A JSON-RPC batch longer than this, or an empty one, is refused before any
// MCP server, transport or tool handler exists (the SDK's own cap is wider).
const MAX_BATCH_MESSAGES = 16;

function batchRefusal(body) {
  if (!Array.isArray(body)) return null;
  if (body.length === 0) return 'Invalid Request: empty batch';
  if (body.length > MAX_BATCH_MESSAGES) {
    return `Invalid Request: batch must not exceed ${MAX_BATCH_MESSAGES} messages`;
  }
  return null;
}

async function handleHttp(req, res, opts) {
  const refused = batchRefusal(req && req.body);
  if (refused) {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: refused }, id: null });
    return;
  }
  const server = createServer(opts && opts.getPacket, { ...opts, auth: authFromVerifiedRequest(req) });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

module.exports = {
  TOOL_NAME,
  SERVER_NAME,
  SERVER_VERSION,
  REQUIRED_SCOPE,
  ALLOWED_ORIGINS,
  SECURITY_SCHEMES,
  ANNOTATIONS,
  INSTRUCTIONS,
  MAX_BATCH_MESSAGES,
  batchRefusal,
  originAllowed,
  toolDescriptor,
  packetResult,
  createServer,
  handleHttp,
  authFromVerifiedRequest,
};
