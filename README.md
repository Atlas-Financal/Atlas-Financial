# Household finances — private dashboard

A password-protected household finance site built around a practical 90-day
plan, with the historical analysis and interactive payoff and mortgage-renewal
modelling behind it.

**This repository must stay private.** It contains balances, rates, income and
debts. It contains no account numbers, card numbers, names or addresses — but it
is still the whole financial picture of two people.

---

## What is in here

| Path | Purpose |
|---|---|
| `server.js` | Express app: browser gate, assistant auth boundaries, security headers, serves the data |
| `data.json` | **Every figure on the site**, including the `plan` block the forecast runs on |
| `public/index.html` + `plan.js` | **Plan** — the homepage: 90-day forecast, budget, next actions |
| `public/forecast.js` | The 13-week projection engine — pure, DOM-free, node-testable |
| `public/modellers.html`, `planning.html`, `plan-spend.html` (+ `.js`) | Legacy pages, **switched off**: `SWITCHED_OFF_PATHS` in `server.js` answers each with a 302 to `/`. Files kept on disk until their #822 removal slice; `deepdive.*`, `records.*`, `bills.*`, `subscriptions.*` and `credit.*` are already removed and their paths still redirect |
| `public/app.js` | Shared core: helpers, charts, theme, navigation, boot |
| `public/styles.css` | Styling, light and dark |
| `test/test-local.js` | Smoke test for the auth gate — run it after any change to `server.js` |
| `test/test-forecast.js` | Tests the forecast engine — run it after any change to the `plan` block |
| `render.yaml` | Render blueprint |

## Security model

- **Fails closed.** Without `SITE_PASSWORD` and `SESSION_SECRET` the server
  refuses to start, so a misconfigured deploy cannot serve the data publicly.
- `data.json` is served **only** to an authenticated session. It is not in the
  static directory.
- `GET /assistant/current` is a separate read-only consumer. It is not unlocked
  by the browser session. It requires `ATLAS_ASSISTANT_TOKEN` as
  `Authorization: Bearer`. Unset → 503. It never writes.
- The household Talk page and its `/talk/*` routes were removed on 2026-11-11
  (owner decision, #821 comment 6786692208). Those paths are now ordinary
  unknown paths behind the session gate.
- `POST /assistant/mcp` exposes the incumbent packet as `get_atlas_current`,
  plus direct Lunch Money catalog, transaction lookup, edit preview and confirmed apply tools. It accepts only issuer-signed JWT access tokens issued
  for the exact MCP resource with scope `atlas.current.read`; the static
  assistant token and browser cookie do not work there. Atlas publishes OAuth
  protected-resource metadata at `/.well-known/oauth-protected-resource`,
  verifies the exact configured issuer identifier, signature/JWKS, audience,
  expiry/not-before, and scope on every request. Lunch Money tools also require
  an authenticated JWT `sub`; catalog/query require `atlas.transactions.read`
  and preview/apply require `atlas.transactions.write`. `atlas.current.read`
  does not grant ledger access. A preview/apply call from a token without
  `atlas.transactions.write` is refused with HTTP 403 `insufficient_scope`
  naming all three scopes, so the MCP client can ask for write consent on
  demand; the base challenge never requests write up front.
  Only category/notes edits and amount-conserving splits are supported.
  Opaque access tokens are not supported.
- OAuth login, consent, authorization-code + PKCE, client registration, token
  issuance, and refresh belong to the configured external standards-compatible
  authorization server. Atlas is only the resource server; it adds no user
  database or second login platform.
- Sessions are stateless HMAC-signed cookies — HttpOnly, SameSite=Lax, and
  Secure whenever the request is HTTPS. A tampered cookie is rejected.
- Login attempts are throttled to 8 per 15 minutes per IP.
- `noindex` headers plus a `robots.txt` that disallows everything.
- A strict Content-Security-Policy; no inline scripts, no third-party requests.

**`SITE_PASSWORD`, `SESSION_SECRET`, and `ATLAS_ASSISTANT_TOKEN` live in
Render environment variables in
production, and in your own shell's environment variables when running
locally.** Never commit them, never put them in `data.json`, never send
them to the browser, and never write them to a log.
`ATLAS_MCP_RESOURCE_URL`, `ATLAS_OAUTH_ISSUER`, and `ATLAS_OAUTH_JWKS_URI`
are non-secret OAuth endpoint identifiers, also supplied through the deployment
environment. OAuth access and refresh tokens are never Atlas configuration and
are never exposed by the MCP response.
[`ARCHITECTURE.md`](ARCHITECTURE.md) holds the rule for every secret Atlas may
legitimately hold, and is the one home for it.

## Running it locally

The small Budget build label is bound to the HTML serving that page, using
`RENDER_GIT_COMMIT` (or the existing local `ATLAS_GIT_SHA` override). `npm ci`
captures non-secret, exact-commit provenance in the gitignored
`.atlas-build.json`; the server rejects a different SHA and can fall back to
local Git metadata. Parent headers are read from that exact commit object, so
shallow build checkouts need no ancestor history. Standard two-parent GitHub
merge messages for this repository identify the PR automatically. For
squash/rebase merges, an explicit final `Atlas-PR: <number>` commit trailer can
preserve that identity. A generic issue
reference, unmarked direct/rebased commit, missing Git, or ambiguous metadata
keeps the truthful commit-only label. No GitHub API/token is used at build time
or in the browser. The artifact is server-only and contains no financial data.

Set the two environment variables, then start. Placeholders below are shown in
angle brackets deliberately — the pre-commit hook blocks anything that looks
like a real secret assignment, including in documentation.

```bash
npm install
export SITE_PASSWORD=<at least 8 characters>
export SESSION_SECRET=<at least 16 characters>
npm start
```

Then open http://localhost:3000. On Windows PowerShell, set the same two
variables with `$env:` prefixes before running `npm start`.

GitHub `main` moves when pull requests merge; this folder does not. Fast-forward
local `main` without switching you off a feature branch or discarding work:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-main.ps1
powershell -ExecutionPolicy Bypass -File scripts\sync-main.ps1 -InstallTask
```

`-InstallTask` registers an at-logon and every-2-hour run. The task only
fast-forwards `main`. It never pushes, never force-updates, and never touches a
dirty worktree.

Run the smoke test against a running server:

```bash
node test/test-local.js
```

## Deploying to Render

1. Push this repository to a **private** GitHub repo.
2. In Render, create a new Web Service from the repo (or use the blueprint in
   `render.yaml`).
3. Set **`SITE_PASSWORD`** by hand to a strong shared password.
4. Let Render generate **`SESSION_SECRET`**.
5. After the 2026-08-23 read-only pass, also set **`LUNCHMONEY_ACCESS_TOKEN`**
   and **`ATLAS_PROVIDER_ACCOUNT_MAP_JSON`** by hand in Render. Never put
   those values in git. `ATLAS_LIVE_OVERLAY=live` is declared in
   `render.yaml`. `/healthz` does not depend on Lunch Money.
6. To enable the incumbent direct read-only surface, set
   **`ATLAS_ASSISTANT_TOKEN`** by hand in Render to a dedicated secret of at
   least 32 characters. Do not reuse `SITE_PASSWORD`. Unset →
   `GET /assistant/current` returns 503.
7. To connect ChatGPT, configure an external OAuth 2.1 authorization server
   that supports authorization code + PKCE S256 and ChatGPT client
   registration, and that issues issuer-signed JWT access tokens carrying
   the exact configured issuer, the exact MCP resource audience, expiry, and
   `atlas.current.read` scope. Opaque access tokens are not supported; Atlas
   verifies JWTs locally against the issuer JWKS and does not introspect.
   Then set **`ATLAS_MCP_RESOURCE_URL`** to the public `/assistant/mcp` URL,
   **`ATLAS_OAUTH_ISSUER`** to that exact issuer identifier (do not add or
   remove a trailing slash), and **`ATLAS_OAUTH_JWKS_URI`** to its HTTPS
   JWKS. Missing or partial OAuth configuration → MCP and its metadata
   return 503. Invalid, expired, wrong-audience, or insufficient-scope
   tokens fail closed.
8. `ATLAS_TALK_GEMINI_API_KEY` is no longer read (Talk removed 2026-11-11).
   If it is still set in Render, the owner deletes it there.
9. Deploy. Every push to the default branch redeploys automatically.

The free plan sleeps after inactivity, so the first visit in a while takes about
thirty seconds to wake. For a couple of check-ins a week that is fine.

## Updating the picture

Edit `data.json`, commit, push. Render redeploys and the site reflects the new
figures. No HTML or JavaScript changes needed for a routine update.

When adding an account, add an entry to `debts` (and `revolvingExtra` if it is
an overdraft rather than a debt). Headline, net-worth and income totals are
derived from those rows — do not store a matching copy.

## What this is not

Financial education and planning support — **not** professional financial, tax,
legal, mortgage or investment advice. The modellers are illustrative: they
assume rates hold and no new spending goes on, and they ignore fees, penalties,
qualification and loan-to-value. Real decisions need a licensed professional.

## Related

- **`AGENTS.md`** / **`CLAUDE.md`** — how work gets done here: who decides, who
  reviews, and what a pull request has to carry before it merges
- **`docs/AGENT_CONTEXT.md`** — authority vs on-demand skills vs
  non-authoritative technical lessons
- **`CONTEXT.md`** — read first in a new session: layout, state, standing rules
- **`ARCHITECTURE.md`** — how the layers fit together, where new material goes,
  and the staged direction
- **`docs/ACCOUNT_FACTS.md`** — rates, limits, due dates, the renewal date
- **`docs/RISK_LABELS.md`** — the CI gates, and the defect each one exists to
  catch

Raw bank exports and statement PDFs live in `raw/` on this machine only. They
contain names, addresses and partial card numbers, are gitignored, and are
additionally blocked by `.githooks/pre-commit` (local) and the incumbent
privacy-guard CI job (GitHub API / connector writes).


### Direct Lunch Money ChatGPT tools (owner authorization 2026-10-02)

Deploy the updated server, configure the external issuer to grant
`atlas.transactions.read` and, for edits, `atlas.transactions.write` alongside
`atlas.current.read` for the exact MCP resource, then reconnect/refresh Atlas
Financial in ChatGPT so tool discovery and consent include the new scopes. The
issuer must provide a stable authenticated `sub`. Reuse the server-side Lunch
Money credential; never paste it into chat.

Call `get_lunchmoney_catalog` for all synced/manual account balances and
account/category references. Savings are included. Each account carries its
provider account type/status, exact signed decimal balance and currency,
semantic balance date (`balance_last_update` for synced accounts,
`balance_as_of` for manual accounts), and separate object/sync timestamps.
Missing or invalid balances/currencies are unavailable, never zero; missing
dates remain unknown and future dates are flagged. The response lists all
accounts returned by these two provider endpoints, including closed/inactive
accounts. It does not establish that every household account is linked, include
the separate crypto endpoints, or force a bank sync. Reading now is not evidence
that the bank balance is current. Provider-reported balances retain unknown
verification trust; show their dates and any account status that needs attention.
Do not combine cash with amounts owed or different currencies, or treat savings,
restricted/business funds or available credit as spendable cash. Forecast still
owns household spend permission. This uses the existing ledger-read scope and
the same three catalog GETs; no new client, OAuth scope or provider write.

For transactions, call
`get_lunchmoney_transactions` with explicit start/end dates. Category-group
filters include their subcategories. Account lookups include individual group
children and omit group parents so purchases are counted once. These tools expose
selected ledger fields including payee and notes, unlike the sanitized Atlas
packet. References and previews expire after ten minutes or server restart.
For a correction, `prepare_lunchmoney_edit` produces an exact preview; after the
user confirms that preview, `apply_lunchmoney_edit` writes and verifies readback.
An uncertain write must be reconciled by lookup, never automatically retried.
Pending, grouped and already split transactions cannot be edited in this slice.
Preview state is process-local; use a single instance or session affinity. A
restart or different instance fails closed. Re-reading detects stale previews,
but the provider offers no atomic compare-and-swap against another client's
concurrent edit. Atlas does not change canonical facts or bank balances.
