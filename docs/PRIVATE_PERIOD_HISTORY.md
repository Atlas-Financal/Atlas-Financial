# Private pay-period retention

**FOUNDATION — NOT COMPLETION. Automatic retention and Sheet writes are not active.**

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
monthly source, possibly empty), optional
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
not-captured. The seam is inert — no server route, scheduler or automatic
caller uses it; the CLI `capture-closing` verb is the only caller, and it is
explicit operator invocation, not activation.

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

The free Render filesystem is ephemeral and no durable disk is configured.
A paid disk, new hosted storage, persistent credential/OAuth grant, security
change or scheduled job requires separate owner authorization. The PRIVATE Sheet
is a read-only reporting mirror until a supported already-authorized connection
is verified for its writer; ChatGPT connector access is not Atlas runtime access.
Only allowlisted aggregates/provenance may leave the private evidence boundary.
No raw archive belongs in Git, CI artifacts/logs, a PR, browser, or public output.

This schema/private write boundary requires Atlas Contract / Systems Review on
the completed implementation head under `CLAUDE.md`. This document supplies no
merge approval and does not weaken existing canonical/provider approval paths.
