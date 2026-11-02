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

`figures-review.yml` runs the engine on the base and head and comments with the
figures that changed. `scripts/figures-snapshot.js` covers Plan, Bills,
Subscriptions, Credit, and Planning household-facing figures; Deep Dive,
Records, and Modellers remain outside. It exists because the shipped weekly-cap defect changed a
derived answer without crashing. The workflow is advisory because moving a
figure is often the purpose of a PR; an unexplained mismatch between the comment
and merge card is still a correctness defect to resolve.

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
Codex automatic reviews run on every pull request when it is opened for review
or marked ready, without an `@codex review` comment. Under `CLAUDE.md`
("Review lanes, finish lines and rulings"; Independent improvement audit) they
are not an advisory pass: their findings are dispositioned as usual, and any
advisory pass is a separate, requested audit. That lane is operational: PR #63 received a real
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
