# Lunch Money capability audit and read-only expansion

Source: Dale's explicit instruction (this PR). Authority checked before any
change: `AGENTS.md`, then `CLAUDE.md`, on current `main`
`657339f46862f187ba2ab81c066e5cd474318b2b` (the merge of PR #560), plus the
official Lunch Money API specification, OpenAPI 3.0.2 / Lunch Money v2.11.1,
fetched from https://lunchmoney.dev/v2/openapi on 2026-10-09. PR #560 and
PR #561 were inspected before building; PR #548 was not touched.

Current-state verdict: **PARTIALLY FIXED** — the incumbent connection reads the
catalog, current balances and transactions, and writes bounded transaction
edits, but several documented read-only endpoints have no Atlas consumer.
Code was required for exactly one of them (below).

## What already works on current main

| Capability | Provider surface | Atlas state |
|---|---|---|
| Identity check | `GET /me` | Used by the live provider-observe fetch |
| Catalog: categories (incl. group children), tags | `GET /categories`, `GET /categories/{id}`, `GET /tags` | `get_lunchmoney_catalog`; references expire after 10 minutes |
| Current account balances | `GET /plaid_accounts`, `GET /manual_accounts` | Catalog evidence: exact decimal strings, per-account currency, semantic balance date (`balance_last_update` / `balance_as_of`), trust `unknown`; no combined totals |
| Transaction reads | `GET /transactions`, `GET /transactions/{id}` | Assistant query pages at 250/page until `has_more=false` (max 20 pages, then fail-closed), `include_pending=true`, `include_group_children=true`, group parents excluded, split parents excluded by provider default; provider-observe separately fetches a dated window plus an unbounded pending universe with `include_metadata=true`. Original bank description (`original_name`), notes, tags, amount and currency preserved |
| Bounded transaction writes | `PUT /transactions/{id}?update_balance=false`, `POST /transactions/split/{id}` | PR #560 (merged) on top of #559: displayed payee, existing category, additive notes, additive existing tags, evidence-backed transfer labels, conserving splits. Preview + exact confirmation, or the bounded standing grant for routine cleanup; single-use previews, re-read before write, readback verification of requested and untargeted fields, durable before/after audit, never retry an uncertain write |
| Attachment fields on transactions | `files` when `include_files=true` | Compared by the cleanup financial-effect proof when both responses supply them; no Atlas attachment read or download tool exists |

## What is missing (documented API, no Atlas implementation)

| Roadmap item | Provider surface | Status in this PR |
|---|---|---|
| Historical account balances | `GET /balance_history` (monthly) | **Implemented — see below** |
| New/changed transaction reads | `GET /transactions` with `created_since` / `updated_since`, plus `recurring_id`, `tag_id`, `status` filters and `include_files` | Missing — NEXT PR candidate |
| Budget summaries | `GET /summary`, `GET /budgets/settings` | Missing — Engine handoff (below); budgets themselves (`PUT`/`DELETE /budgets`) are a write and a Forecast-authority question, not plumbing |
| Recurring-item reads | `GET /recurring_items`, `GET /recurring_items/{id}` | Missing — NEXT PR candidate (Atlas's `recurring-audit.js` derives candidates from transactions; it does not read provider recurring items) |
| Receipt attachments | `POST /transactions/{id}/attachments`, `GET /transactions/attachments/{file_id}` (signed URL), `DELETE` | Missing — write path; reuse #560's safeguards when built |
| Group workflows | `POST /transactions/group`, `DELETE /transactions/group/{id}`, `DELETE /transactions/split/{id}` (unsplit) | Missing — write path (split creation already exists via the bounded preview path) |
| Card purchase/payment reconciliation | No dedicated endpoint; built from transaction reads + Forecast allocation | Engine handoff (below) |
| Historical pay-period snapshots (original plan vs actual vs final surplus) | **No provider endpoint exists for Atlas plans** | Atlas-side preservation only — Engine handoff (below). Lunch Money balance history is monthly and must not be presented as a pay-period snapshot |

Also documented but out of the roadmap and not built: crypto endpoints,
`/me` settings reads/writes, manual-account and category/tag creation or
deletion, `POST /plaid_accounts/fetch`, and bulk transaction
create/update/delete. Nothing here widens Atlas toward any of them.

## Website-only — no documented public API endpoint

Verified against the v2.11.1 OpenAPI path list (37 paths) on 2026-10-09:

- **Native rule management.** There is no `/rules` endpoint. Rules appear only
  as an `apply_rules` flag on transaction insert, as dependency counts on
  category/tag deletion, and as `auto_create_*` settings toggles. Creating,
  editing, listing or deleting Lunch Money rules requires the Lunch Money
  website. Do not invent an endpoint.
- **Full transaction change history.** There is no history/audit endpoint;
  a transaction carries only `created_at` / `updated_at`. Atlas's own #560
  audit records only Atlas-dispatched attempts — it does not cover changes
  made in the Lunch Money website or by any other client, and must never be
  described as complete transaction history.

## The one capability implemented here

`GET /balance_history` as a new read-only assistant operation
(`balanceHistory`) and MCP tool `get_lunchmoney_balance_history`:

- Explicit month window only: `startMonth` and `endMonth` are both required
  (`YYYY-MM`), start ≤ end, at most 120 months. The endpoint has no
  pagination; the single response is consumed whole and its shape is
  validated before anything is returned.
- Accounts are mapped through the incumbent catalog so plaid and manual
  accounts that share a provider id still get distinct references. Crypto and
  deleted-account sources are returned with `accountMapping: 'unavailable'`
  and a reason — never an invented reference, never silently dropped.
- Each entry keeps its kind: `historical` (stored month-end balance) or
  `current` (ephemeral snapshot, may change between requests). Provider
  entry ids are validated internally for historical rows but are never
  returned — no raw provider ID crosses this boundary, per the
  ARCHITECTURE.md OAuth boundary. Exact provider decimal strings, signs and
  currencies are preserved per account; provider base-currency conversions
  are omitted; no total across accounts or currencies is produced.
- Synced-crypto source identity is `crypto_synced_id` plus the validated
  `symbol` (the official v2.11.1 stream identity): distinct symbols under
  one connection are distinct streams, a repeated id+symbol pair fails
  closed as a duplicate, and a missing or malformed symbol fails closed.
  Crypto sources still get the unavailable catalog mapping above.
- A missing or invalid balance or currency is returned as
  `status: 'unavailable'` with `amount: null` and a reason — never zero.
  Duplicate account blocks, duplicate months for one account, malformed
  payloads and malformed entries fail closed with a sanitized diagnostic.
- Read scope only (`atlas.transactions.read`). GET-only: the test stub asserts
  every provider call is a GET with no body. No Forecast, classification,
  planning or published-figure code is touched; trust stays `unknown`.
- The result states plainly that this is monthly evidence — not an Atlas
  stored opening (Atlas's own `balance-history.json` / snapshot records are a
  separate, incumbent concept), not a pay-period snapshot, and not the
  original plan for a period.

## Engine handoff (not implemented here — Forecast/Engine owns these)

Muse owns connection plumbing, retrieval, interface components and tests.
The following change financial classification, calculations or allocation and
are handed to Engine; this PR deliberately does not implement them:

1. **Budget summaries.** When `GET /summary` / `GET /budgets/settings` reads
   are plumbed in a later PR, Engine decides whether and how provider
   budgeted/available figures may be displayed next to Forecast figures
   without creating a second planning authority. Provider `budgeted` /
   `available` must never be published as Forecast figures.
2. **Card purchase/payment reconciliation.** Engine owns the allocation
   decision (which purchase a card payment settles, minimum-payment identity,
   settlement timing). Plumbing may supply matched transaction evidence only.
3. **Split/group/transfer classification.** The write plumbing exists (split)
   or is documented (group); whether a given split/group/transfer changes
   classification is Engine's call, proven through the incumbent
   financial-effect path before any standing use.
4. **Historical pay-period snapshots.** Engine/Atlas must preserve, at period
   close, the original Forecast plan, the actual spending evidence and the
   final surplus as separate dated records, with dated revisions when late
   postings arrive. Lunch Money monthly balance history is an input to
   checking those snapshots, never a substitute for them, and a late posting
   must revise the snapshot record — never rewrite the original plan.
5. **Automatic cleanup activation.** The #560 machinery is merged inactive.
   Any activation, and any expansion of its financial-effect proof, is an
   Engine + owner decision, not a plumbing change.

## Blocker carried, not repaired here

**Retired 2026-11-11:** the isolated form (`public/transaction-edit.*`) was removed by owner decision (#821 comment 6786692208; Lunch Money edits are handled elsewhere), so this blocker and its checklist item below no longer gate anything. Historical record follows.

PR #561 (isolated transaction-edit form) has an open independent finding
(comment 6094423036 on head `98ea5c7cae44f8ddffdf7c4e21579beab3c6aa63`):
close/reopen while an `apply` is still pending can open a second editing
instance, because the shared pending registry is only populated when the
first apply settles as uncertain. #561 must have that pending-save
close/reopen defect repaired and independently reviewed before the form is
integrated with any live adapter — including an adapter built on this PR's
service. This PR does not duplicate that repair and does not touch #561's
files. Future write work reuses #560's connection and safeguards.

## Production prerequisites checklist (separate from this PR)

This environment's missing access does not prove production is missing any of
these. Each item must be verified in production on its own evidence before
the balance-history read is relied on there:

- [ ] The deployed assistant runtime actually exposes the new MCP tool
      (`get_lunchmoney_balance_history` appears in `tools/list` for a
      read-scoped token) after a deploy of this head — code merged is not
      code deployed.
- [ ] The production Lunch Money credential in place resolves through the
      incumbent credential path and is authorized for GET-only observation;
      no new token, grant or consent is created by this PR.
- [ ] The production provider base URL configuration
      (`Provider.lunchMoneyApiBase(env)`) resolves to the v2 API, and a
      read-only `GET /balance_history` against the production account returns
      the documented `balance_history` array shape (v2.11.1).
- [ ] OAuth: clients that should use this read hold `atlas.transactions.read`
      in the issued JWT scope (permissions claims alone do not widen access —
      see the incumbent interface tests).
- [ ] Reference expiry is understood by the consuming client: catalog
      references (and therefore balance-history account references) expire
      after 10 minutes and must be re-read, not persisted.
- [ ] No figure on any household surface consumes this read yet. Any future
      surface that displays monthly balances is a separate PR with its own
      trust tagging (provider-reported / `unknown`) and, if it publishes a
      figure the household acts on, its own Systems Review.
- [x] ~~#561's pending-save defect (above) is repaired and independently
      reviewed before any live transaction-edit integration proceeds.~~ Retired 2026-11-11 with the form (above).
- [ ] #560's activation prerequisites remain exactly as recorded in
      `docs/LUNCHMONEY_CLEANUP_CONNECTION.md` and
      `docs/STANDING_LUNCHMONEY_CORRECTIONS.md`; nothing in this PR advances
      automatic-cleanup activation.
