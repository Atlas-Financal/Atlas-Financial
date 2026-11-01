# Risk labels and review gates

This file records the repository's merge gates, what each gate checks, and the
demonstrated failure that justifies it. [`CLAUDE.md`](../CLAUDE.md) owns review
authority and the bounded review protocol.

## Primary risk — exactly one, from the Merge Card

| Label | Meaning | Owner action |
|---|---|---|
| `auto-safe` | No published figure moves and no fact changes home. | None. Merge on green when no systems-review trigger fired. A high-risk trigger still waits for Atlas Contract / Systems Review `NO BLOCKERS FOUND` on the current head; a non-builder merger decides. |
| `figures-moved` | A figure the household reads changes. | Read the figures diff and reconcile it with the card. |
| `owner-decision` | A household fact or owner-reserved decision is outstanding. | Answer the exact question. |
| `blocked` | A hard gate failed or a real blocker remains. | Do not merge. |

The Merge Card `Primary risk` row is the authority. The GitHub primary-risk
label is a synchronized projection of that closed value, not a second
judgement. `risk-label-gate.yml` reads the live card, applies exactly that
label, removes the other three, and requires the live GitHub label to equal
the card. It runs from the default-branch workflow through
`pull_request_target`, so a pull request cannot weaken the copy of the gate
that judges it. A malformed card fails red and does not invent a label.

Category labels are descriptive and non-blocking:

`engine` · `published-figures` · `plan-page` · `authority-docs` · `security` ·
`tests` · `infrastructure` · `evidence-only`

## Hard gates

### `merge-card-check`

The merge card check validates only that the card is complete and aligned
with itself:

- the Atlas Merge Card heading exists;
- the required table rows exist and are not blank placeholders;
- `Current-state verdict` opens with one documented closed value;
- `Primary risk` opens with one of `auto-safe` / `figures-moved` /
  `owner-decision` / `blocked`. Plain text and ordinary Markdown inline
  code are both accepted (`auto-safe` or the same word wrapped in
  backticks). Presentation is normalized before the closed vocabulary
  is checked. Only those four values are valid;
- the review decision opens `REQUIRED` or `NOT REQUIRED`;
- a not-required review records `N/A` for head, reviewer, and outcome; and
- card text is read from the live pull request (`pulls.get`), not the workflow
  event body. A closed PR, a non-`main` base, a PR or repository identity
  change, or a live head that is not the event head fails closed.

It does **not** fail on a review SHA, a review outcome value (`BLOCKERS
FOUND` / `NO BLOCKERS FOUND` / `INCOMPLETE` / `PENDING`, or a historical
`PASS` / `NOT PASS` / `BLOCKING`), reviewer identity, or a trusted Atlas
review, and it authenticates nothing. Those fields stay on the card as the
governance record. Completeness of `REQUIRED` / `NOT REQUIRED` is structural,
not a judgement that the human trigger decision was correct, and not a GitHub
lock on review findings. A later fix must not turn this check red.

Required governance and a required GitHub status check are different things.
When a high-risk trigger fires, Atlas Contract / Systems Review remains
required before merge; this workflow still does not parse or enforce its
findings.

Confidence that the change is not junk is the job of `npm test`, the secret
hook, and the figures comment. This check only stops an empty or malformed
card.

`test/test-mergecard.js` executes the real inline workflow script. It proves missing
fields and invalid closed openings fail, and that review SHA / PASS / PENDING
do not. It proves the check reads the live PR body rather than the workflow
event body, and that a moved live head or a closed or retargeted PR fails
closed. It also proves `workflow_dispatch` with matching live PR/head succeeds
and fails closed on mismatch.

### `tests`

`npm test` runs the suites registered in [`test/test.js`](../test/test.js), which is the
registry. This file keeps no copy of that list: a second inventory drifts as
soon as a suite is added, and a gate document that misstates what the gate runs
is worse than one that does not enumerate it. One lived here until 2026-08-12
claiming seven suites against a registry that held fifteen.

What the suites are is `test/test.js`'s. **Why they block** is this file's, and each
one earns it against a demonstrated failure:

- the weekly cap double-counted a payday;
- one page published `$1,650/week` and `$0/week` for the same concept;
- standing facts contradicted each other in separate locations;
- the incumbent authority table repeatedly omitted real financial authorities;
- a new authority surface could otherwise be added without being registered; and
- the raw-data pre-commit safety hook silently stopped running after its
  executable bit was lost.

The authority-surface guard deliberately claims coverage only of the named,
mechanically enumerable surfaces recorded by `B75`: Forecast exports, the named
`data.json plan.*` policy keys, the payoff/renewal calculators, and the named
artifact-writing scripts. It proves that removing a known row or adding a new
Forecast export without classification fails. Page scripts that decide rather
than render remain a review-detectable class because no honest closed mechanical
signature exists for them.

The numerical suites use independent totals or identities where correctness is
at stake. A test of the same function that computes the answer is not an
independent reconciliation.

### Security and secret checks

The static suite and pre-commit hook keep identifiers, raw/derived data,
credentials, secrets, PDFs, and protected security behavior out of tracked
changes. These controls remain hard because the repository contains private
household source material and previously lost its hook protection silently.

### `privacy-guard`

GitHub API / connector commits never run `.githooks/pre-commit`. The
demonstrated failure is that structural bypass (B77 / PR #5): the local hook
is not on that write path, so a connector-authored file the incumbent policy
would reject can still reach review. `privacy-guard.yml` applies
`scripts/privacy-guard.js` — the same engine the hook runs — from the trusted
default branch to the incoming PR head, treated as data. The PR cannot
weaken the copy that judges it. Generic card/SIN checks in `test/test-static.js`
are not a second household-identifier list.

The job publishes a `privacy-guard` commit status on the PR head because
`pull_request_target` otherwise attaches to the default-branch SHA. Adding
that context to required checks on `main` is an owner repository-setting
action. The control is permanent while GitHub write paths exist that skip
local hooks.

### Owner-reserved gates

No workflow can authorize raw-data handling, credentials, security
infrastructure, a household fact, an estimate-to-verified promotion, a store,
financial-data connectivity, or a direction change. The owner gate in
`CLAUDE.md` remains blocking.

## Review surfaces

### Published figures review — advisory reconciliation

`figures-review.yml` runs each revision's own `scripts/figures-snapshot.js` on
the base and head and comments with counts of the captured fields that changed.
It exists because the shipped weekly-cap defect changed a derived answer
without crashing. The workflow is advisory because moving a figure is often the
purpose of a PR; an unexplained mismatch between the comment and merge card is
still a correctness defect to resolve.

What one comparison observes:

- **Inputs.** The household dated opening (`data.json` with
  `public/periods.json`), which is the only household evidence CI has and
  whose figures leave the runner as counts only, and the invented inputs in
  `test/fixtures/figures-inputs/`. Each invented input is frozen served data
  with `invented: true`, a description, a reviewable origin in an existing
  invented builder or ledger, and its own periods payload or an explicit
  `absent-periods` limitation. An invented input is compared like for like only
  when its digest is unchanged; an added, edited or removed input is counted as
  such and withholds acceptance, never reading as an engine move.
- **Fields.** Plan, every Budget pay period (opening, bill load, hold, Balance
  After Deductions, sweep, planned close and each bill row), Savings closes and
  every goal row and grouped member the Budget savings card renders (Saved,
  Needed or its range endpoints, This period, Still to fund, Paid facts and the
  member allocations), Bills, Subscriptions, Credit and Planning, each with its
  trust tag,
  read through Forecast's own publications with the Budget page's default
  `recommend()` options. That is an engine-input parity subset, not page parity.
- **Savings page capture (evidence).** For every input, the Budget and Plan
  spend pages are executed in a Node vm through their own boot
  (`App.boot`, once-hooks, then the registered entries) over a declared state
  matrix: each selectable pay period by funding lens, month view and drilldown.
  Each page loads its own script list from its HTML. The capture refuses, or
  records as a load error, these enumerated forms: script element forms other
  than `src="/name.js"`; scripts inside HTML comments (parsed as browsers do,
  including `<!-->`, `<!--->` and `--!>`) or `<template>`; `on*` attributes in
  any tag spelling; dynamic `import(`, `eval`, `Function` and string-argument
  timers, matched both on the page script's raw, unmodified text and on its
  comment- and literal-masked text (`scripts/js-scan.js`), so inert mentions
  inside strings, comments or regex literals are refused too (a disclosed
  cost); runtime script, iframe or frame elements,
  `document.write`/`writeln`, `Worker`/`SharedWorker`, `importScripts` and
  service-worker registration; and `on*` handlers assigned to elements, the
  document (any name) or the window (a finite, pinned list of the HTML
  standard's handler names), or set through `setAttribute`, which are recorded
  as deferred registrations. It does not prevent arbitrary JavaScript
  execution: forms outside this list, including computed `eval` or
  constructor chaining and a window handler name outside the list, are covered by the page HTML and script pins, the machinery pins
  and exact-head review. `server.js`, which rewrites the Budget HTML it serves,
  is pinned as machinery. The page's own `public/forecast.js` runs in the page
  realm, as in the browser. Every actual `Forecast.savingsFundingPublication`
  call is recorded with its consumer route (the calling function and its
  caller), its context identity (null versus absent, which advice, which view,
  the entry's plan), the identity of its first argument and its typed-encoded
  result (`scripts/figures-page-capture.js`). After each state renders, the
  capture also records per-advice anchors: unobserved calls to the page's own
  selector, one per exact context the routes use (`{asOf, advice}`,
  `{asOf, advice, periodId: null}`, the plan-bearing contexts of the Budget
  mount and Plan spend, and per pay-period view `periodId`, `period` and the
  raw period packet). A test proves these calls leave every render,
  observation and result unchanged. Each object result also carries identity
  subparts: the positive class of its own `period` (ready-built, ready-built
  then withheld, unknown-built, or a period packet, each by its exact key list
  and constants; any other form is unsupported), with digests of its key list,
  kind, dates and status. After each Budget state renders, the capture also
  records same-execution gate facts, as fixed yes/no words only: the eight
  facts of the Calendar's own inventory validation and step-specific `asOf`
  equality, whether an inventory is present, and, from the trajectory and
  schedule that state's own `budgetTrajectoryFor` and
  `budgetMonthPlanSpendSchedule` calls returned (pass-through observers), the
  month, payday and drilldown gates. Dated view ids embed the period start in
  plaintext, as state ids already do; this evidence stays private. The record
  is compared as `savings.capture.*` (evidence v4).

  **The validators' guarantee is bounded.** Both validators (the formatter
  and the independent posting step) check schema, relationships, constants and
  internal consistency, per result. For every observation they derive the
  result's variant and view from its page, state, route, context and source,
  plus that state's anchors, and require: the object or null verdict of the
  anchor for that exact context (anchors are never substituted for one
  another; the agreement the pinned selector implies between the omitted,
  null and plan-bearing contexts is a versioned invariant that fails closed);
  the exact own top-level key set and producer order of the variant (the
  goal allocation by the allocation-mode part, the planned requirements and
  close by the view role, the top-level reason by the period class); the
  constant parts; a positive period class whose kind, dates and status bind
  to the same page, state, advice and view; one result per view and one
  top-level result per page, distinct across views and equal across Budget
  states (no declared state variable is an input of `recommend`, which a test
  pins). Budget's anchors must also equal the input's itemized pay periods and
  Savings publication (the collector's own engine run); Plan spend builds its
  own advice, so its anchors are not independent (a disclosed limit). The
  exact state list comes from the input's own itemized pay periods. Each
  state's observations must equal its expected roster exactly: the adopted
  steps in fixed page order, each identified by route, context shape, source
  role and position, present exactly when that state's anchors, gate facts and
  itemized pay period predict it (funded or not), with the predicted object or
  null outcome; a pass-through must name that state's own goals call. A
  missing, extra, duplicated or reordered step, a published period packet that
  is not read raw, or a gate fact that disagrees with the roster reads
  INCOMPLETE, as does any other violation. Plan spend's anchors share the
  capture's provenance. Anchor contexts are main-realm objects with the page's
  keys and order: an anchor that disagrees with its observation reads INVALID,
  but agreement does not show realm independence. Gate facts and anchors are
  capture-written and not authenticated. The pay-period gate facts must be
  equal across the default and pay-period states. The month and drilldown gate
  facts belong to one state each and have no independent binding (the
  collector's own trajectory uses other options), so a coordinated edit of
  such a fact together with the steps it governs is not detected: a named
  limit.

  The validators do **not** establish that a non-constant part digest encodes
  the original value: nested or optional content, empty versus populated
  arrays, or two swapped non-constant parts. That fidelity rests on the
  capture-side tests, which rebuild every result from lossless descriptor
  originals taken at observation time, with an independent reference encoder,
  and a mutation matrix whose rows the reconstruction must reject
  (`test/test-savings-capture-fidelity.js`, over published invented inputs and
  the committed repros in `test/fixtures/savings-capture/`, plus two labelled
  perturbation tests for withheld packets and publications). Evidence replaced
  as a whole, itemized anchors included, is not authenticated: the evidence is
  written by PR code on the same runner, and a fully self-consistent forgery
  remains possible (the collector is pinned machinery). A digest change locates
  a change; it does not explain it. The vm is not a production browser or a
  sandbox. Not captured: persisted knobs, balance history, and the declared
  limits below.
- **Declared limits of the Savings capture** (Atlas 6552087494, adopted by
  Muse 6552134028). The capture covers the selector and raw-packet
  consumption, not every recommend-derived figure the pages print. These print
  without passing through the selector, so their values are not captured;
  their producer and consumer source is guarded (a source edit is a review
  obligation, not numerical movement):
  - `period.fromTodayFunding`: the From-today evidence, the Today card and
    Costs ahead (the proposal to set aside now, capacity, cash after the
    proposal and the forward per-payday proposals);
  - `plannedCostFunding.afterProposedFunding`, printed as Balance After
    Deductions when a period has no daily packet;
  - `savingsInventory.pools` and the compact-stock gate, which are only
    partially observed.

  A legitimate no-selector-call state is not a claim that no financial figure
  renders.
- **Consumer source guard.** `test/test-savings-consumer-contract.js` compares
  the guard with `test/fixtures/savings-consumer-manifest.json`. Under the
  operative rule (Muse 6550973450), `forecast.js` has the selector-region pin
  plus function-level pins over its execution-reached set, and every other
  module has function-level pins over its reached set, observed with V8
  coverage of the real-entry capture. A module wrapper is module scope whatever
  its syntax. Each reached module has a residual pin over everything outside
  its function definitions (wrapper glue, the export table, module-scope data,
  top-level statements), normalised outside literals only. A whole-module pin
  applies where reach cannot be established: the module cannot be parsed, none
  of its functions execute, or it registers callbacks the capture never
  invokes and its handlers are not modelled by the state matrix. The page script
  lists and HTML bytes, and the capture, collector, validator, poster and guard
  machinery, are pinned too. Unexecuted branches and helpers inside a
  function-level module are the declared unexecuted-path limit, covered only by
  exact-head review. Any difference fails until the inventory is reviewed. This
  is a change detector and review obligation, not proof of numerical movement.
- **Declared field classes.** A fixed vocabulary in `scripts/figures-comment.js`,
  mirrored by the posting step. A class is observed on an input when a matching
  field holds a finite amount (a legitimate zero counts), a non-empty tag, or the
  declared boolean; an explicit null is a withheld state, not coverage. One
  observed value establishes that the field is published, not that every branch
  of it is exercised.

Results: **changed** or **introduced** withholds acceptance, as before.
**INCOMPLETE** means a declared class is observed by no input, or the coverage
manifest is missing, malformed or does not reconcile with the captured fields;
it fails with its own message and is reported even when values also changed.
**Unchanged** passes only when nothing compared moved, no invented input was
added, edited or removed, and every declared class is observed. It means no
captured field moved on those inputs, nothing more.

Not covered, and stated on every comment: household figures at a live opening
(no provider access in CI; private route only), page rendering and page-side
decisions (the PA-5 unavailable verdict, ATLAS-080 settlement qualification),
persisted or adjusted page knobs, spending-period history on invented inputs
that declare none, and branches inside an observed class. Deep Dive, Records,
and Modellers remain outside. A figures-moved PR whose move lands on no input
still reads unchanged for that move; that result is not figures evidence for it
(`PRIVATE_FIGURES_REVIEW.md`).

The posting step loads no PR JavaScript: it recomputes the whole public body
from the inert snapshots and posts only on byte equality, after re-checking the
live base and head SHAs. Snapshots stay in `RUNNER_TEMP`. The control is
permanent while figures-moved PRs are accepted on this comment plus the owner's
private look; the hand-declared class list retires when a mechanical
publication registry derives it, and the invented half narrows when a
page-rendered snapshot over the same inputs supersedes it.

### Atlas Contract / Systems Review — trigger-based required governance

This review is required governance when a high-risk trigger in `CLAUDE.md`
fires, and it is not required otherwise. A non-builder reviewer — Atlas
(ChatGPT) by default — performs it on the current exact PR head and records
factual findings: `BLOCKERS FOUND`, `NO BLOCKERS FOUND`, or `INCOMPLETE`. The
findings are not merge authorization; a non-builder merger other than Atlas
decides. The active builder cannot satisfy it.

It is **not** a GitHub status check. `merge-card-check` does not parse or
enforce reviewer identity, the outcome value, or review-SHA equality.

Request it only on a stable merge candidate: implementation complete, merge
card current, applicable deterministic checks green, figures review completed
when applicable, any optional advisory pass completed, genuine high-severity
advisory findings already repaired, and the head expected to stay stable.
Correct-but-improvable work may proceed; optional advisory suggestions need
not all be fixed.

A `BLOCKING` result repairs only the named blockers, proves them, and requests
bounded re-review of that new exact head. If a repair itself introduces
another genuine high-risk blocker, one bounded repair is reasonable. Further
blocker-after-blocker churn stops and returns to the decision desk.

### Retired paid OpenAI first-review / re-review

The paid OpenAI first-review and re-review workflows are retired. Their parked
versions exited successfully without performing a review, so their green runs
could be mistaken for progress. Required Atlas Contract / Systems Review is
requested directly in the active ChatGPT decision-desk session with the pull
request number and exact head SHA. GitHub handoff artifacts are evidence only;
they do not wake ChatGPT, satisfy the review, or add API spend.

### Cursor repair of failed tests

A red `tests` or merge-card completeness check starts **one automatic
Cursor repair** (`atlas-test-repair.yml`). Codex findings still use the
existing Cursor repair path. Both test the patch before pushing. Two
failed test-repair attempts stop and comment rather than loop. A repair
must not weaken a financial test or invent a figure.

ChatGPT decision-desk advice remains optional help. It is a separate role
from the trigger-based Atlas Contract / Systems Review.

### Independent improvement audit — optional

Default to at most one advisory pass. A second pass is justified only for a
high-severity/systemic finding or a response that materially changes a high-risk
runtime, security, schema, authority, cutover, or product-trust surface. The
retired `codex-review.yml` freshness reporter is not needed under this rule: an
ordinary push does not create a requirement to rerun an optional audit. Native
Codex automatic reviews are the intended first advisory pass: Codex docs say
they post when a pull request is opened for review or marked ready, without an
`@codex review` comment. That lane is operational: PR #63 received a real
`chatgpt-codex-connector[bot]` review that found implementation defects. Codex
remains advisory. It is not Atlas review authority. The `codex-review-request.yml`
comment dispatcher remains retired: it never successfully posted `@codex review`,
and it is not replaced by another token or dispatcher. A justified second pass
remains a human `@codex review` comment. Atlas Contract / Systems Review, Merge
Card, and Codex→Cursor handling of genuine submitted Codex reviews remain
intact; deleting the broken dispatcher does not remove a hard merge authority.

## Control retirement

Governance controls are not grow-only. `CLAUDE.md` owns the lifecycle rule. A
control may be narrowed or retired when another surviving control covers its
demonstrated failure at least as directly, or when the protected path no longer
exists and a focused regression test proves that fact.

The retired controls in the simplification were review-prose parsing,
negation handling, advisory freshness reporting, review-round accounting,
machine-scored scope/atomicity narratives, and open-loop arithmetic. None
protected product behavior. The surviving tests, reconciliations, invariants,
security checks, exact-head equality, risk label, and owner gates do. The
later-retired `codex-review-request.yml` comment dispatcher is the same class:
it was a broken 403-producing comment poster, not a hard merge authority.
Native Codex automatic reviews are the intended first-pass advisory mechanism
and are proven operational as of PR #63. They remain advisory. Atlas Contract /
Systems Review, Merge Card, and Codex→Cursor handling of genuine submitted
reviews remain the surviving authorities.

## Setup

The labels are created from `.github/labels.yml`. Add `tests`, `Merge card
mechanical fields`, `risk-label/primary`, and `privacy-guard` to branch
protection's required status checks for `main`. The owner makes that repository-setting change; a
workflow does not grant itself merge authority. Standing auto-merge of
qualifying `auto-safe` pull requests is owner-granted as of 2026-08-16 and
must not become operational until GitHub itself is enforcing those checks.
That grant does not apply to `figures-moved`, `owner-decision`, `blocked`,
or any other owner-reserved stop.
