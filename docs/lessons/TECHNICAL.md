# Technical lessons (non-authoritative)

Engineering lessons only. Not household truth, not owner policy, not
Forecast, not a second authority. Rules:
[`README.md`](README.md).

## L-001. Page scripts must not compute household financial answers

- **Status:** active
- **Evidence:** `B73`; `ARCHITECTURE.md` records the homepage that
  published `$1,650/wk` beside `$0/wk` because two pieces of code
  answered the same question; closed by moving recorded decisions
  into `Forecast`.
- **Lesson:** If a page needs a number that does not exist yet, add it
  to `public/forecast.js` and render the result. A page-side
  calculator is an unnamed authority.
- **Not:** a weekly cap, a substitute for the incumbent table, or
  permission to add a second planner.

## L-002. A test of the producing function proves consistency, not correctness

- **Status:** active
- **Evidence:** `AGENTS.md` ("The proof has to be independent");
  `CLAUDE.md` Current-State Verification Gate; build-strategy M3.
- **Lesson:** Reconcile a household-facing figure against a second
  method, an institution number, or a total that has to agree.
- **Not:** a claim that `npm test` is optional, or a household fact.

## L-003. Exact-head means the pull request head, not `workflow_run.head_sha`

- **Status:** active
- **Evidence:** the retired paid-review workflow history (its suites,
  `test-github-pr-head-sync.js` and `test-atlas-review-block.js`, were
  removed with the retired scripts under #822; see git history).
  `pull_request` dispatchers run on `refs/pull/<n>/merge`, so
  `workflow_run.head_sha` is that synthetic merge commit.
- **Lesson:** Compare review freshness to the associated PR head (or
  the merge commit's second parent). Do not equate
  `workflow_run.head_sha` to the live head.
- **Not:** a second review lane, a merge lock, or ChatGPT identity
  enforcement in CI.

## L-004. Copied work-state in always-loaded docs drifts

- **Status:** active
- **Evidence:** `CONTEXT.md` records a second read order that lived
  there until 2026-08-12 and had already omitted documents the
  router listed; `ARCHITECTURE.md` Tier 1 records a copied gap list
  that called MBNA / Affirm unknown while `BACKLOG.md` had capture
  complete.
- **Lesson:** Do not copy current progress, suite inventories, or
  sequencing into `ARCHITECTURE.md` or `CONTEXT.md`. Point at
  `BACKLOG.md` and the build strategy.
- **Not:** a freeze on those files, or a household balance.

## L-005. Source intake and interviews are not facts or policy

- **Status:** active
- **Evidence:** `docs/MASTER_PLAN_REQUIREMENTS.md` ("two boundaries
  this file has already crossed");
  `docs/household_interviews/README.md`.
- **Lesson:** File attributed speech as interview evidence and
  document-established facts as intake. Promoting either to verified
  standing fact or joint policy is a separate owner-reserved step.
- **Not:** a payroll number, a provider choice, or a shared target.

## L-006. Live household cents in behaviour tests become a false specification

- **Status:** active
- **Evidence:** `B92` / `AF-TEST-01`; `test-refresh-isolation.js`.
  Before the unpin, changing Chequing A broke 8 suites / 61
  assertions.
- **Lesson:** Engine behaviour uses synthetic fixtures and independent
  arithmetic. Live cents belong only in deliberately live
  reconciliation. A copied household figure is not a specification.
- **Not:** permission to weaken an invariant, or a current balance.
