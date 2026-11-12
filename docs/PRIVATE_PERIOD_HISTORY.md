# Private pay-period retention

**FOUNDATION — NOT COMPLETION. Sheet writes are not active. Automatic capture is wired but off until the owner turns it on.**

Owner instruction, 2026-10-09: preserve financial pay-period history and populate
the owner's private reporting Sheet. This code-only slice can capture an
existing observation, append it privately, and retrieve the frozen publication.
It adds no provider transport, credential store, server route, scheduler,
infrastructure, financial policy, canonical writer, or Sheet connection.

Forecast remains the sole calculator/classifier. `scripts/private-period-history.js`
uses incumbent observer normalization, `Live.fromObservation`, operating-answer
options and `Forecast.recommend`. It selects one native `payPeriodViews` row;
it does not calculate category totals, historical targets, income, bills or BAD.
Current policy cannot become an original historical plan. Native nulls, zeros,
trust labels and coverage limits are retained unchanged.

## Private interface

`capture(input)` is in-memory only. Input is an already-read private JSON object
containing `data`, `payload`, `accountMap`, `identity`, `periods` (the existing
monthly source: the parsed `public/periods.json` object with an array `monthly`, or an
empty array when none is supplied), optional
exact Forecast cycle `periodStart`, and `kind` (default `first-observed`). No
implicit current data, account map, identity policy or monthly source is loaded
as financial input. The existing operating projector reads its default monthly
file while composing options, but the caller's explicit `periods` replaces it
before Forecast runs. Input is not changed. The engine commit is read from Git,
and loaded transitive financial source files are hashed; a dirty financial
engine is refused rather than falsely attributed to a committed version.
Capture time belongs to the runtime clock. A caller-supplied `capturedAt` is
refused, so an old source fetch cannot be backdated into an original opening
publication. The in-process synthetic-clock seam is for isolated tests and is
not exposed by the CLI or an activation setting.
The existing live-map validator is required; fixture maps cannot authorize a
private production capture. Synthetic tests supply invented identities under
the same schema and perform no live GET or real capture.

`append({destination, candidate, enabled})` defaults to disabled and requires
`enabled: true`. The destination must already exist outside every Atlas
worktree and any other repository/bare repository. Public/static directory
segments and symlink components are refused. POSIX destinations must be owned
by the current user with no group/other access. Credentials/session/environment
objects and secret-like keys are refused. Never include authentication values
in financial notes or other source strings.

`read({destination})` returns metadata only. `read({destination, revisionId})`
returns a validated private record in-process for an authorized local consumer.
An optional `expectedHead` pins the last successful revision receipt and detects
tail truncation during recovery; a hash chain alone cannot detect removal of an
entire final suffix without that independent receipt or backup manifest.
`replayPublication(record)` uses frozen refreshed state and exact Forecast
options, checks the retained engine file hashes, and verifies equality with the
stored publication. It cannot substitute today's policy. Original provider
inputs are also retained for a later observer replay, with stable IDs, original
merchant, notes/tags, split/pending links and available source update timestamps.

Local operator commands:

```text
node scripts/private-period-history-cli.js capture --input <existing-private-input.json>
node scripts/private-period-history-cli.js capture --input <existing-private-input.json> --destination <verified-private-directory> --enable-private-history
node scripts/private-period-history-cli.js capture-closing --input <existing-private-input.json> --destination <verified-private-directory> --enable-private-history
node scripts/private-period-history-cli.js list --destination <verified-private-directory>
node scripts/private-period-history-cli.js inspect --destination <verified-private-directory> --revision <revision-id>
```

The first command previews metadata with capture disabled. Every CLI command
prints metadata or a fixed error code, never financial rows, source identities,
private paths or provider failures. The next reporting consumer is an explicitly
activated private runner and allowlisted aggregate Sheet mirror. Neither exists
as part of this PR; this is not a production-history completion claim.

**Rollover closing seam (issue #818, slice 1).** `captureClosing(input)` takes
the same already-read private input as `capture`, but owns the closing
selection itself: it derives the observation as-of, takes the Forecast cycle
containing it, walks back one cycle, and captures that latest fully-ended
period with kind `closing` and the derived `periodStart`. A caller-named
`kind` or `periodStart` is refused (`history-closing-selection-invalid`), and
every existing closing gate in `capture` still applies. `appendClosing`
appends the candidate under the same disabled-by-default, private-destination
rules as `append`, except that an existing `closing` record for the period is
a clean `already-captured` no-op instead of a singleton conflict, so a
rollover trigger may observe the same rollover repeatedly. Only the latest
closed period is named: earlier missed periods are not backfilled and stay
not-captured. Besides the CLI `capture-closing` verb, its one automatic
caller is the capture-on-refresh writer below, which is off unless the owner
turns it on.

## Versioned publication/evidence contract

`atlas-private-period-history/v1` (legacy) and `/v2` (new captures, below) record the Forecast cycle start/end inclusive
and household timezone; capture time separately from financial as-of and source
fetch time; engine commit/file fingerprints; source, policy, map and identity
fingerprints; source completeness/pending/observation receipts; native publication;
and private replay evidence. Records have a global sequence, SHA-256 revision ID,
previous revision, baseline reference and capture checksum. These detect damage
and accidental modification; they are not cryptographic authentication against
a malicious process with the same user's filesystem access.

- `original`: the first qualified observation on the opening household day.
  Both source fetch and capture must fall on that day, financial as-of must
  equal the cycle start, and the overlay must be applied. This does not assert
  a midnight/pre-transaction cash snapshot. Native opening uncertainty remains.
- `first-observed`: the initial observed baseline; original opening unavailable.
- `reconstructed`: a completed-period publication using the captured current
  policy, explicitly not the missing original historical plan.
- `plan-amendment`: requires an existing baseline, separate `declaredAt` and
  `effectiveFrom`, a revision reason, and preserves that baseline. Those are caller-supplied owner
  evidence, not inferred approval or a new policy authoring path.
- `closing`: one observed publication after period end; as-of must reach its
  end. Source coverage and native unavailable values can remain incomplete.
  A paginated-complete fetch does not prove all bank postings are final.
- `actual-correction`: requires a closing observation and appends another
  revision with a reason for changed posting, categorization, source/config or engine evidence.

Opening baselines and closing observations cannot be replaced. A matching retry
returns the existing revision. Identical financial/source content at a later
fetch/capture clock is a no-op; changed private evidence remains a revision even
when the published amounts agree. Prior periods without captured originals keep
that gap. No retention pruning or automatic deletion is implemented.

## Declared completeness, closing state and cutoff (v2, History H1)

New captures are written as `atlas-private-period-history/v2` and carry three
capture-time labels inside `content`. They are reprinted from fields the observer
and Forecast already publish. They compute no figure, change no publication and
are not a planner input.

- `cutoff: { rule: 'household-day', end, tz }`. `end` is the Forecast cycle's
  inclusive last household day and `tz` is `America/Vancouver`. The period
  includes every transaction dated through that household day. Source fetch
  time and capture time are recorded separately and are never the cutoff.
- `closingState: 'provisional' | 'complete-at-capture'`. The state is
  `complete-at-capture` only when **both** of these hold: (1) declared
  `sourceCompleteness` is `complete` with an empty `reasons` list, and (2) both
  the source fetch and the capture fall on a Vancouver household day after
  `end` (the next-household-day gate; DST-aware via `Forecast.financialDate`).
  So 23:59 on the end day is still provisional, and the next local midnight
  opens the date half of the gate. Historical 2025 PST/PDT proof uses 08:00Z /
  07:00Z respectively; future offsets follow the installed America/Vancouver
  timezone data, not a fixed winter/summer assumption. A fetch at
  23:59 that is captured at 00:00 stays provisional. Every evidence, coverage
  or publication gap stays `provisional` even after the date passes.
  **Complete-at-capture means complete against the declared scope at the time
  of capture, after the period closed.** It does not mean every bank posting
  is final. The existing `closing`-kind gate (capture after the period end,
  as-of reaching the end) is unchanged and separate from this label.
- `sourceCompleteness: { status, reasons[] }`. This is declared evidence
  coverage at capture, not final household truth. `status` is `complete` only
  when `reasons` is empty. Otherwise it is `incomplete`. Reasons use a fixed,
  published order (`REASONS` in the module), so the same evidence always gives
  the same list. Each code is prefixed by its layer. Transport completeness is
  not publication suitability, so the combined status is incomplete whenever
  any layer has a reason:
  - `transport:`: posted coverage is complete only when the posted-window bounds
    cover the whole period, `complete=true`, `hasMore=false` and nothing is
    truncated. Each failing condition is retained as its own reason: an absent
    window, a contradictory declaration (complete while has-more/truncated,
    inverted bounds, or a window ending after its own fetch day), missing the
    start, missing the end, not complete, has-more (true or unknown) and
    truncated. Pending coverage is complete only with the unbounded
    `is_pending-unbounded` basis, `complete=true` and `hasMore=false`. A
    date-bounded pending query is `pending-coverage-bounded-window`. Any
    other gap is `pending-coverage-unproven`. A source fetched on or before
    the cutoff day is `source-fetched-before-cutoff`.
  - `evidence:` keeps these and never drops them: missing expected mapped
    accounts, unobserved required cash, undated balances, and transactions on
    unmapped accounts. It also keeps a missing or unresolved obligation
    reconciliation receipt (untrusted, fail-closed reasons, ambiguous or
    unverified occurrences, or one-to-one violations), and a missing
    current-period actuals packet. It keeps `cardCoverageUnconfirmed`,
    `currencyUnconfirmed`, and any non-CAD or currency-less actuals row.
  - `publication:` covers what Forecast itself marked unavailable:
    `operatingPlanUnavailable`, card purchase coverage unavailable, absent
    budget progress, a non-CAD/absent progress currency, an actuals coverage
    claim other than `precise`, and native income/bills/household actuals that
    are unavailable (non-finite) or partial. It also covers any household
    category whose native `spent` is unavailable. A native `0` is a true zero
    and is never treated as unavailable. A native `null` is never turned into
    zero.

`completeness(record)` and `metadata()` return `{ status: 'unknown' }` and
`closingState: 'unknown'` for any record without this metadata. A record
without it is never presumed complete.

**Legacy v1 records are unchanged.** They are never upgraded or rewritten in
place. Their bytes, `captureId`, `revisionId` and `contentKey` still verify. A v1
record may not carry the v2 labels, and a v2 record must carry all three with a
canonical reason order. A v2 revision may chain after a v1 head. `contentKey`
excludes the three derived labels, as well as fetch time and receipts. So
retrying the same content gives the same key, and the existing revision is
returned instead of a duplicate. That holds across v1 and v2 too. A retry that
only crosses the closing gate is the same evidence. It returns the earlier
revision, and a real closing observation remains its own `closing` kind.

The provenance `reconciliationReceipt` field now retains the observer's
`report.obligationReconciliationReceipt`. Before H1 it read a non-existent
`report.reconciliationReceipt` and was always `null`. Legacy records keep their
recorded `null`.

Out of scope here: H2–H6, including the H4 view module, the scheduler, Drive,
the Sheet, real captures and activation.

## Hosted PostgreSQL archive (owner-approved storage, not active)

**What the owner approved.** On 2026-11-06 (PR #831 comment 6694409045) the owner
approved keeping the archive in hosted PostgreSQL (Neon Free), so it survives a
Render restart. The approval covers summaries only. It does not cover raw provider data,
the canonical transaction store (`ARCHITECTURE.md` gate unchanged), a runner, a
scheduled job or activation. Its only caller is the capture-on-refresh writer
below, which is off until the owner turns it on.

**Added 2026-11-12 (#821 comments 6812320225 and 6812433768).** The owner
approved one automatic capture: one read-only, GET-only observation per pay
period at rollover, whose only write is one appended record in this archive.
`ARCHITECTURE.md` ("Period-close capture") holds the exact scope and what it
does not authorize. The job is described under "Capture at rollover" below. The owner also approved a saved
close keeping, in his recorded words, "the savings goals, card balances and the
final Balance After Deductions" (figures, dates and trust tags only). Nothing
wider is recorded as approved. Each block arrives with the PR that builds it;
the contents listed below are what is stored today.

**What it stores: a sanitized projection, not the full revision.**
`scripts/private-period-history-postgres.js` stores
`atlas-private-period-history-projection/v1`. It holds the period, kind, as-of,
plan basis, owner-supplied amendment/correction fields, completeness labels and
cutoff, the engine commit plus one fingerprint of its files, and provenance
fingerprints with transaction-window/pending-coverage flags. It also holds an
allowlisted set of the native Forecast period's own figures: opening, income,
bills, budget hold, planned close and its terms, predicted ending, trust labels,
and plan-defined income, bill and budget-category rows. Every level has a closed key list. A
key outside it, or a value of the wrong type, is refused on write and on read.
Because the list is closed, a field or balance term that Forecast adds later is
**dropped on purpose** until someone adds it to the allowlist deliberately. A
test pins the 1.0 comparison fields below, and the full current term sets, so
losing one of those fails rather than passing silently.

It never stores the `evidence` block, raw provider payloads, transaction rows
(including Forecast's own `recon` / `pendingRecon` lists), provider ids,
merchant or payee strings, notes, tags, account names, observer receipts or
free-text notes. As a second guard behind the allowlist, a write is
refused (`history-projection-provider-text`) when a projected string value
contains provider text from that capture's evidence:

- **Free text** is checked against every projected value. It covers payees,
  merchants, notes, tags, account names and provider ids, from transactions and
  their split `children`, from accounts and tags, and from the free-text and id
  fields of `plaid_metadata`.
- **Category names** are checked against label-like values only. They cover
  provider categories with their groups and children, `category_name` and Plaid
  category arrays. Words like "Bills" or "Savings" also occur inside Forecast's
  fixed identity strings. A budget-row label exactly equal to a category name is
  allowed, because Forecast's fixed budget labels ("Groceries", "Fuel") share
  that vocabulary.
- A projected value that is exactly an owner plan string, and provider text that
  is exactly an owner plan string, are owner vocabulary and are not leaks.

A false match refuses the write with that code. It never stores anything.

**Accepted limit.** The hosted archive cannot replay a publication.
`replayPublication` needs the evidence, which stays with the private file
backend. After a Render restart the hosted archive proves what was
published for a period, and when, but cannot recompute it. That limit was
accepted with the owner decision.

**For the 1.0 comparison.** To compare a period's published close with the next
period's observed opening, the projection holds
`plannedPeriodClose`, `plannedPeriodCloseTrust`, `plannedPeriodCloseTerms`,
`predictedEndingBalance` and `end` for the earlier period, and `opening`,
`openingKnown`, `openingAsOf`, `openingSource`, `paydayBoundaryOpening`,
`currentBalance` and `start` for the next. The values are reprinted, never recalculated.

**Same guarantees as the file backend.** One shared contract suite
(`test/test-private-period-history-store-contract.js`) runs unchanged against
both backends. It covers append-only revisions, idempotent retry that returns
the same revision, `history-original-or-closing-conflict`, every revision hash
intact on read-back (damage fails closed), and fail-closed behaviour when
disabled, unconfigured or unreachable. Both backends use one append decision
(`planAppend` in `scripts/private-period-history.js`). Each Postgres append runs
in one transaction under a transaction-scoped advisory lock. The lock is released
on commit, rollback or session end, so no stale lock survives a crash. The stored
text must be byte-identical to its canonical form and re-hash to its revision id.
If the session is lost after the INSERT, the result is `history-commit-uncertain`.
Retry the same candidate: it returns the committed revision or appends it once.
The writer role has SELECT and INSERT only. PostgreSQL itself refuses UPDATE,
DELETE and TRUNCATE.

**Connection.** The connection string comes only from the Render environment
variable **`ATLAS_PERIOD_HISTORY_DATABASE_URL`**. It never goes in the repo,
`data.json`, logs, errors or the browser. Errors are fixed codes
(`history-store-unconfigured`, `history-store-config-invalid`,
`history-store-tls-required`, `history-store-unavailable`), with at most a
stage/category/SQLSTATE diagnostic and never the value. The string must name
Neon's **direct** host (not `-pooler`) and end in exactly
`?sslmode=verify-full`. Any weaker mode, or any other parameter, is refused.
The session is owned by the shared connection owner
`scripts/settlement-evidence-postgres-connection.js` with `profile:
'period-history'`, which applies the same TLS, role, timeout, sanitization and
retirement rules as settlement. Its one-table preflight runs on PostgreSQL 16
to 18. Nothing migrates at startup: the table exists only once the owner runs
the setup below.

**TLS trust path (documented, no live call made).** Neon serves certificates
from Let's Encrypt (ISRG Root X1), which is in Node's built-in root store. So
`verify-full` needs no extra CA file. The owner also refuses `NODE_EXTRA_CA_CERTS`,
`SSL_CERT_FILE`, `NODE_OPTIONS`, `PG*` and similar variables, so trust cannot be
redirected. The Render service must not set them. The first owner connection is
the live proof. A TLS failure reports category `tls` and nothing else.

### Owner setup (one time, about ten minutes)

1. In Neon, create a project (Free plan). Open its **SQL Editor** on database
   `neondb`.
2. Make a long random password using **letters and digits only** (at least 32
   characters; a password manager can generate one). Paste the SQL below into the
   editor, replace `CHANGE_ME_LONG_RANDOM_PASSWORD` with it, and press **Run**
   once.
3. In Neon's **Connect** dialog, turn **Connection pooling off**, so the host has
   no `-pooler`. Copy the connection string. Replace the user and password with
   `atlas_period_history_writer` and your new password. Replace everything after
   `?` with `sslmode=verify-full`. It should look like
   `postgresql://atlas_period_history_writer:PASSWORD@ep-example-123456.us-east-2.aws.neon.tech/neondb?sslmode=verify-full`.
4. In Render, open the Atlas service, then **Environment**, and add the variable
   `ATLAS_PERIOD_HISTORY_DATABASE_URL` with that string. Do not put it anywhere else.

<!-- period-history-setup-sql:start -->
```sql
CREATE SCHEMA atlas_period_history;
CREATE TABLE atlas_period_history.revisions (
  sequence integer PRIMARY KEY,
  revision_id text NOT NULL,
  record text NOT NULL
);
CREATE ROLE atlas_period_history_writer LOGIN NOINHERIT CONNECTION LIMIT 1
  PASSWORD 'CHANGE_ME_LONG_RANDOM_PASSWORD';
ALTER ROLE atlas_period_history_writer SET search_path = pg_catalog;
GRANT USAGE ON SCHEMA atlas_period_history TO atlas_period_history_writer;
GRANT SELECT, INSERT ON atlas_period_history.revisions TO atlas_period_history_writer;
```
<!-- period-history-setup-sql:end -->

The local real-PostgreSQL test runs this exact block, then proves that the
owner's preflight accepts the result and the role cannot rewrite history. Adding
the variable activates nothing by itself.

### Capture on refresh (#818; off until the owner turns it on)

`scripts/period-history-refresh-capture.js` runs only when the Render variable
**`ATLAS_PERIOD_HISTORY_CAPTURE`** is exactly `on`, and turning it on is an
owner decision. It has no schedule: the trigger is a qualified live refresh,
which happens when someone opens Atlas. The one scheduled writer is the
capture at rollover below.

- After a qualified live refresh, the refresh owner offers that refresh's own
  retained source evidence. One background worker thread builds the capture
  input (canonical data, that evidence, the live account map, the
  transaction-identity rules and the parsed `public/periods.json`, the same object the
  served path gives Forecast; a missing file or a shape without an array `monthly`
  fails closed as `history-capture-input-invalid`) and appends to this
  archive:
  - the latest fully-ended period as one `closing` record; and
  - the current period's baseline: `original` when the observation falls on
    the opening household day, otherwise `first-observed`.
- A period that already has a closing, or a baseline, is a no-op. So is a
  concurrent writer that won it first. Every later refresh observes the same
  rollover harmlessly.
- It is fire-and-forget. `offer()` never throws or waits, and starts no work in
  the caller's turn. The work runs off the main thread, so a failed or slow
  store changes and delays nothing served. One capture runs at a time. A day
  that reached a terminal result is not retried; a failure is retried no sooner
  than ten minutes later. Each outcome is logged as
  `{"type":"period-history-capture","closing":<code>,"opening":<code>}`, with
  fixed codes only.
- A period's closing is captured once and never upgraded. It is recorded as
  `provisional` unless its gates pass at that capture (for example, when the
  refresh's posted window does not reach the period's start), and a later
  refresh leaves it as it is.
- If nobody opens Atlas near a payday, a late refresh still records the close,
  and the opening is `first-observed`. A period with no refresh at all before
  the next one ends is never captured (no backfill).
- Engine identity: a Git checkout of this repository must name its HEAD with
  the engine files clean. Only when no checkout is readable (a deploy without
  `.git`) may a 40-hex `RENDER_GIT_COMMIT` stand in, beside the recorded file
  hashes. With neither, capture is refused (`history-engine-version-unavailable`).

Nothing reads the archive back into the page yet; that is the next step (#818).

### Capture at rollover (owner-approved 2026-11-12; off until the owner turns it on)

`scripts/period-history-auto-capture.js` is the one scheduled writer, with the
exact scope `ARCHITECTURE.md` ("Period-close capture") records. It runs only
when **both** `ATLAS_PERIOD_HISTORY_AUTO_CAPTURE` and
`ATLAS_PERIOD_HISTORY_CAPTURE` are exactly `on` (non-secret values set by hand
in Render); merging it activates nothing.

- `server.js` starts it after it listens. It ticks 60 seconds after boot and
  then every 15 minutes, with unreferenced timers.
- Each tick names the latest closed pay period from `data.json` and today's
  household date alone, with no provider call. If this process already saw
  that period's closing, it stops there.
- Otherwise it asks the archive whether a `closing` exists for that period.
  If one does, it stops: no provider request.
- Only when none exists does it make one private observation in its own
  worker: the on-demand refresh's own GET-only Lunch Money read, through the
  same server-side token. It builds the closing through the existing seam and
  appends that one record. It never writes the opening baseline.
- The observation is never published into the served observation memory,
  never replayed to a page load, never goes through `withProviderWrite` and is
  never written to `data.json`. A failed or missed attempt changes nothing that
  is served.
- Retry bound: a failed attempt that saved nothing is tried again until the
  closing exists or the next rollover passes. An attempt may start only in one
  of six fixed 15-minute windows per household day (opening at 00:00, 04:00,
  08:00, 12:00, 16:00 and 20:00 America/Vancouver), once per window, and only in
  a process that was already running when the window opened. The bound comes
  from the clock, so restarts add no attempts.
- A worker that runs past its time limit is terminated, and the session gate
  stays held until it has exited.
- The whole attempt holds one archive session, from the closing check through
  the observation and the append. Because the writer role allows one connection,
  an instance that tries while another holds the session is refused before any
  provider request, and that refusal spends its window. The connection owner
  reports a lost or retired session synchronously (`onLoss`), before the
  connection is released, and that aborts the in-flight read.
  An observation starts only while this instance holds the single archive
  connection; if that connection is lost, the observation is aborted at once,
  so two observations are never both in progress except for the moment it
  takes an aborted request to stop. At most one attempt per instance per
  window (six windows per household day); none once a closing exists for the
  period; after a failed attempt, a second instance alive at that window may
  make its own attempt.
  In-process, it shares the one-session gate with
  the archive read and the capture-on-refresh writer; when the session is busy,
  the tick skips. While an attempt runs (at most a few minutes) the page's
  archive read skips too.
- It logs fixed codes only:
  `{"type":"period-history-auto-capture","closing":<code>,"provider":<bool>}`.

## Reading captured closes on the Budget page (#818)

**A closing reflects the plan in force when it was captured.** The closing for a
pay period is captured on the first qualified refresh after the period ends,
with that refresh's plan. If the plan changes after the period ends and before
that refresh, the closing records the changed plan. Once captured, a closing is
never replaced, so later plan changes cannot move it. Capture is reliable only
when someone opens Atlas on or right after payday.

**What a captured close is, and what it is not.** The closing is Forecast's
completed-period row, built from the first post-period refresh: the period's
own actual income, bills and household spending. It is not end-of-period cash,
and it is not the projection shown on the period's last day. On the last day
the period is still current, so its Balance After Deductions still holds back
the unspent household budget. Once the period has ended, Forecast deducts what
was actually spent. So the two figures differ by the released hold (in the
invented acceptance world: 1,000 on the last day, 1,270 as closed).

Any comparison of a period's close with the next period's observed opening,
including the 1.0 two-period reality check, must therefore compare
like-for-like fields: either projected end cash against the next observed
opening, or the close plus the released hold. Acceptance 5.8 reads the
last-day figure as the close and stays open for that decision.

`scripts/period-history-read.js` attaches the archive's records to the
browser's `/data.json` as `periodHistory`. It is off unless
`ATLAS_PERIOD_HISTORY_CAPTURE` is exactly `on`, the same switch as capture.
`withHistory()` never throws and never waits on the store. It serves the last
completed read, or nothing, and starts one background read when that read is
older than ten minutes. A failed or slow read serves the page exactly as it
would be without history.

Only the fields Forecast reprints leave the archive: the period, kind, capture
time, as-of, closing state, plan basis, the policy fingerprint, and the
allowlisted publication. Source fingerprints and engine identity stay in the
archive.

Forecast (`applyCapturedPeriodHistory`, via `recommend`'s `periodHistory`
option) reprints a completed period from its `closing` record:
- The figures, terms and plan-defined income, bill and budget rows come from
  the capture. The period's identity and timeline position stay today's.
- It computes nothing. A malformed or unmatched record changes nothing.
- When the closing's policy differs from the period's earlier capture, the
  period carries `capturedClose.planChangedSinceEarlierCapture: true`. The
  page then says the plan changed and when the close was captured. The figure
  itself is never swapped and never made Unavailable for this.

A captured close keeps its captured trust labels. It is neither withheld nor
relabelled as a reconstruction.

The writer role has `CONNECTION LIMIT 1`, so a read and a capture that overlap
refuse each other (`history-store-unavailable`, SQLSTATE 53300). Both are
triggered by the same served refresh a millisecond apart, so inside one server
process they now take turns through one gate
(`scripts/period-history-session-gate.js`): whichever holds the archive's one
session runs; the other skips that round without spending its retry window and
is offered again by the next refresh or page. Two server processes sharing one
role can still refuse each other and simply retry later.

When the store refuses, the `period-history-capture` log line carries the
connection owner's sanitized `diagnostic`: exactly three fixed fields,
`stage` (for example `connect`), `category` (for example `sql`) and `code` (a
SQLSTATE such as `53300`, or null). It never carries driver text, hosts, users
or messages; anything that is not those three fixed shapes is dropped. A
capture that cannot reach the store logs, for example,
`{"type":"period-history-capture","closing":"history-store-unavailable","opening":"history-store-unavailable","diagnostic":{"stage":"connect","category":"sql","code":"53300"}}`.

## Atomicity, recovery and activation boundary

One exclusive `.capture.lock` serializes writers. One revision file contains
publication plus evidence, avoiding cross-file partial commits. A random private
staging file is flushed; an atomic same-directory hard link publishes it without
replacement; the directory is flushed before success. Incomplete staging files
are ignored. Chain gaps, unknown schema, checksum mismatch, symlink entries or
missing evidence fail reads closed. No stale lock is cleared automatically.

After a crash, an operator must establish that the writer has stopped, validate
the committed chain, and only then remove its stale lock. Preserve committed
JSON files. Staging leftovers can be excluded from backup; a committed revision
is complete even when its staging hard link remains. Retry returns that revision.
An I/O failure after publication has an uncertain outcome; inspect/retry rather
than inventing success. Directory fsync/hard-link support is required and must
be proved on the actual runner/filesystem. Windows ACLs and durability are not
certified by Linux tests. The directory must be under trusted single-owner
control; concurrent hostile processes with the same user are outside this boundary.

Before activation, verify the exact private path, filesystem permissions and
durability, existing GET-only account mapping/access, committed engine, runner
availability, opening/closing capture rule and late-correction refetch cadence.
Capture only refetched source windows; this interface adds no historical polling.
Prove backup and restore into another private directory with every revision hash
intact. The documented owner-PC/OneDrive arrangement is a possible existing
destination, not verified here. `backup-raw.ps1` mirrors deletions and does not
already back up this separate archive or guarantee deletion recovery.

The Render instance's filesystem is ephemeral and no durable disk is configured.
The owner approved one exception (2026-11-06, PR #831 comment
6694409045): the hosted PostgreSQL archive below, holding the sanitized
projection only. Any other paid disk or hosted storage, persistent
credential/OAuth grant, security change or scheduled job still requires
separate owner authorization; the one scheduled job approved so far is the
2026-11-12 period-close capture above. The PRIVATE Sheet
is a read-only reporting mirror until a supported already-authorized connection
is verified for its writer; ChatGPT connector access is not Atlas runtime access.
Only allowlisted aggregates/provenance may leave the private evidence boundary.
No raw archive belongs in Git, CI artifacts/logs, a PR, browser, or public output.

This schema/private write boundary requires Atlas Contract / Systems Review on
the completed implementation head under `CLAUDE.md`. This document supplies no
merge approval and does not weaken existing canonical/provider approval paths.
