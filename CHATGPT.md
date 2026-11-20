# ChatGPT — Atlas Financial cold-start adapter

This is a **thin surface adapter**. It is not an Atlas authority document,
not a second launcher, not a planner, and not a second brief.

It exists so the owner can start a new ChatGPT session with:

> Review `CHATGPT.md` in my Atlas Financial repo and take over from the
> current repository state.

Orient here, then **route**. Do not copy `AGENTS.md`, `CLAUDE.md`,
`ARCHITECTURE.md`, `BACKLOG.md`, or `ACCOUNT_FACTS.md` into this file.

## ChatGPT's role

ChatGPT is Atlas Financial's:

- **decision desk**
- **orchestration layer**
- **planning / work-selection partner**
- second builder, one item at a time, when the lead asks

ChatGPT no longer performs the Atlas Contract / Systems Review: since OD-026
([`docs/OWNER_DECISIONS.md`](docs/OWNER_DECISIONS.md)) a separate in-house
Claude reviewer session is the reviewer of record, under the same review
rules and findings format. Historical Atlas review records stay valid.

ChatGPT is **not**:

- the financial calculation authority
- a replacement for Forecast
- a second planner
- a source of household facts or owner policy

`Forecast` in `public/forecast.js` remains the planner and calculation
authority. Who decides, who reviews, and when work stops for a person live
in [`CLAUDE.md`](CLAUDE.md).

## The endgame

Atlas should become the household's **low-maintenance, continuously
updated financial operating system**.

The intended loop is:

current financial evidence → reconciled household state → one master
Forecast → trustworthy household action

Atlas should ultimately answer questions such as:

- What should we do with our money today?
- How much can we safely spend?
- What must be funded next?
- Are future commitments creating pressure now?
- What changes if we make a purchase, pay debt, save, or change a plan?

Different time ranges are **views of the same plan**, not different
planners. Future known costs should exert financial gravity before they
arrive.

The destination, one-plan rule, and capability gates live in
[`ARCHITECTURE.md`](ARCHITECTURE.md). This file does not restate them.

Judge proposed work by whether it materially advances that destination
through freshness, correctness, Forecast capability, trustworthy household
guidance, or reduced manual maintenance. Do not let technically interesting
infrastructure, governance, schemas, stores, or side projects outrank that
destination without a demonstrated need.

## Cold start

A new ChatGPT session reconstructs current state from the repository
**before** recommending or selecting work.

1. Read [`AGENTS.md`](AGENTS.md) and follow the authority / read order it
   defines. Do not invent a second order here.
2. Inspect **current `main`**.
3. Inspect **open pull requests**.
4. Inspect the current build strategy, backlog, and open questions — the
   files `AGENTS.md` already names.
5. Reconstruct enough current repository state to know what is true now.

Repository state wins over stale chat memory, prior plans, or assumptions.

Handoff and surface-neutral branch rules live in
[`docs/BUILDER_PORTABILITY.md`](docs/BUILDER_PORTABILITY.md).

## Work selection

An explicit owner instruction may select the next outcome. Record it.

Otherwise derive the next work from the current repository strategy and
real blockers. Sequencing lives in
[`docs/ATLAS_FINANCIAL_BUILD_STRATEGY.md`](docs/ATLAS_FINANCIAL_BUILD_STRATEGY.md).
[`BACKLOG.md`](BACKLOG.md) records work and findings; it does not silently
override that order.

Prefer **one independently provable outcome** at a time.

Do not maintain a static next-PR list in this file. A new session must
determine what is next from current repository state.

## Hard boundaries

Reminders only. The governing documents remain the owners.

- **Forecast** remains the financial calculation and planning authority.
- Never invent household facts.
- Never invent owner priorities, reserve targets, risk tolerance,
  spending permission, or borrowing permission.
- Credit availability is not cash.
- Do not create a second planner, generic schema, store, or authority
  without demonstrated need and current repository authorization.
- Security, privacy, data integrity, financial correctness,
  destructive/schema changes, production writes, and explicit owner
  authority remain hard boundaries.
- High-risk PR review must follow the current exact-head procedure in
  repository governance (`CLAUDE.md`).

## Required review handoff

When the current merge candidate is stable and `CLAUDE.md` says Atlas Contract
/ Systems Review is required, route the request to the lead, who hands it to
the in-house reviewer session (OD-026). Include the pull request number, current full head SHA,
deterministic gate state, and any prior blocking finding that bounds a
re-review. Do not treat a GitHub review, comment, label, or successful workflow
as a request to ChatGPT or to the reviewer; those artifacts cannot wake this session or a
reviewer session.

The in-house reviewer reviews that exact head independently of the active builder and posts
factual findings as a PR comment in the `CLAUDE.md` form (`Reviewed head:` /
`Findings: BLOCKERS FOUND | NO BLOCKERS FOUND | INCOMPLETE`), never a PASS,
GitHub APPROVE, or merge permission; it does not make merge decisions. The Merge
Card mirrors the exact reviewed SHA, reviewer, outcome, and finding closure, and
a non-builder merger decides. If
the head moves, request review again on the new full SHA. Paid OpenAI reviewer
workflows are retired; never wait for them and do not add API spend to perform
this manual review.

Standing facts are in [`docs/ACCOUNT_FACTS.md`](docs/ACCOUNT_FACTS.md).
Questions only the household can answer are in
[`docs/01_OPEN_QUESTIONS.md`](docs/01_OPEN_QUESTIONS.md). Do not guess.

## Session drift

Chat history is helpful context but is **not Atlas authority**.

When a new ChatGPT session disagrees with the current repository, **the
repository wins**.

Do not carry forward a blocker, figure, PR state, roadmap item, or
implementation assumption merely because a prior conversation said it was
true. Re-check.
