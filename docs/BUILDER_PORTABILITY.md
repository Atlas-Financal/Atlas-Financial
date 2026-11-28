# Atlas Financial Builder Portability

## Purpose

Atlas Financial work is implemented by the **active implementation agent** on
an owner-approved surface. The lead chooses the model for each build under the
[builder rules](../CLAUDE.md#the-active-implementation-agent). All builders
follow the same workflow, roadmap, and financial safety rules.

This document is a compatibility and handoff contract. It does not select work,
move a financial authority, change a trust label, or create merge authority.
[`CLAUDE.md`](../CLAUDE.md) remains the canonical operating and safety brief;
[`ARCHITECTURE.md`](../ARCHITECTURE.md) owns direction, authority and capability
gates; [`docs/ATLAS_FINANCIAL_BUILD_STRATEGY.md`](./ATLAS_FINANCIAL_BUILD_STRATEGY.md)
sequences planned capability work; [`BACKLOG.md`](../BACKLOG.md) records work and
findings.

## One role, any approved surface

The active implementation agent has the same responsibilities and standing
authority on every owner-approved surface.

- run the Current-State Verification Gate before editing;
- start from current `main`;
- implement one independently provable outcome;
- use the applicable deterministic tests and independent financial proof;
- open and complete the pull request merge card;
- declare builder surface and model without guessing;
- obtain the Atlas Contract / Systems Review when a high-risk trigger fires;
- address real in-scope findings without widening the outcome; and
- hand the reviewed head to an eligible independent merger under the Merge gate.

Surface identity and model identity never change financial correctness,
security, privacy, raw-data, schema, production-write, destructive-operation,
trust-label, or owner-evidence boundaries. They never change who performs the
Atlas Contract / Systems Review.

## Legacy naming map

`CLAUDE.md` keeps its historical filename and remains the canonical detailed
brief. The filename does not make Claude the owner of the workflow.

- **“Claude” used historically as the builder or merger** means the active
  implementation agent or the eligible independent merger for that role under
  `CLAUDE.md`.
- **“Codex review/comments are advisory”** means **independent agent review is
  advisory**. Any agent that is not the active builder may fill that role.
- Existing **`claude/*` branches** are historical and remain valid records.
  For new work, `agent/<outcome>` is the preferred portable branch form; the
  compatibility exception below applies when an approved hosted surface
  enforces its own namespace.
- Surface-specific configuration such as `.claude/` may exist for tooling. It
  carries no independent product, financial, safety, sequencing, review, or
  merge authority unless a canonical document explicitly says otherwise.

If legacy wording and a current canonical rule disagree, follow the current
canonical rule and fix the stale wording in the smallest appropriate governance
pull request. Do not invent a compatibility interpretation that weakens a hard
boundary.

## Branch naming compatibility

The invariant is **fresh current `main` + one outcome**, not a cosmetic prefix.
Use `agent/<outcome>` whenever the approved surface permits the agent to choose a
custom branch name.

Some approved hosted surfaces create the working branch themselves and enforce
a provider-specific namespace. When the surface genuinely cannot create or use
`agent/*`, that platform-generated branch is valid if all of these are true:

1. it was created from the current `main` SHA verified before implementation;
2. it carries exactly one independently provable outcome;
3. the merge card records the enforced branch namespace / surface constraint;
4. it is not stacked on another open implementation branch unless the existing
   atomicity exception applies; and
5. every normal test, review, owner-reserved, and merge rule remains unchanged.

A provider-enforced prefix by itself is **not** a financial, security,
authority, invariant, or product-trust defect. Do not close and recreate a safe
pull request, copy an already-reviewed commit to another branch, or rerun a
systems-review cycle solely to normalize that prefix. If the surface allows a
custom branch, use `agent/<outcome>`; this exception is not permission for an
agent to choose arbitrary names for convenience.

This section owns the branch-name mechanism. Where `CLAUDE.md` uses
`agent/<outcome>` as the generic branch form, read that as the preferred default
subject to this hosted-surface compatibility exception.

## Repository-state handoff

**The repository is the handoff.** Chat transcripts, local scratchpads, model
memory, and a previous agent's verbal summary are never the source of truth.

Before switching agents:

1. Finish, merge, or explicitly abandon the current outcome when possible.
2. Confirm there is no overlapping open pull request or stale feature branch
   being treated as current.
3. Refresh from current `main` and verify the exact starting SHA.
4. Leave the source item, Current-State Verification Gate, merge card, tests,
   independent proof, findings dispositions, and any owner gate in repository or
   pull-request state.
5. Never put credentials, raw statements, derived sensitive output, or other
   prohibited financial data into the handoff.

After switching agents:

1. Read `AGENTS.md`, `CLAUDE.md`, this document, `CONTEXT.md`,
   `ARCHITECTURE.md`, and the build strategy.
2. Inspect current `main`, open pull requests, and relevant current code before
   assuming the next item is untouched.
3. Report the Current-State Verification Gate verdict.
4. Start a fresh branch from current `main`: prefer `agent/<outcome>`, or use the
   approved surface's enforced namespace only under **Branch naming
   compatibility**, unless this is the forced mid-PR handoff exception below.
5. Continue under the same financial, trust, review, and merge gates.
6. Load a skill from `docs/skills/README.md` only when the work matches a
   catalog row. Search `docs/lessons/TECHNICAL.md` for terms related to the
   current task when a recurring failure is relevant; do not read the whole
   lessons store. Neither is household or owner authority.

A new agent should not need a custom history dump from Dale. If repository state
is insufficient, that is a repository documentation/evidence defect to fix —
not permission to guess.

## Work selection after a switch

Work selection does not depend on which model just arrived.

1. An explicit owner instruction may be the source of work; record it.
2. Otherwise, `docs/ATLAS_FINANCIAL_BUILD_STRATEGY.md` decides what is selected
   and in what order. Read the rule there rather than here — that file is a
   sequence, not a gate on the backlog, so an item it has not scheduled is
   **not** ineligible merely because no phase names it.
3. `BACKLOG.md` records work and findings but does not silently jump the planned
   sequence. Unscheduled is not the same as ineligible; which of the two applies
   is the strategy's call, not this document's and not the arriving agent's.
4. The strategy's interruption rules decide when a newly found defect may
   pre-empt the current planned phase.
5. Owner-reserved questions remain owner-reserved on every surface.

No agent may select a more convenient task merely because its model or context
window is better suited to it. Model choice follows the work; the work does not
quietly follow the model.

## Fresh-agent cold-start acceptance trial

This trial tests the portability claim. A **genuinely fresh agent on a different
or newly selected surface, with no prior Atlas Financial chat history or custom
handoff prompt**, opens the repository, reads `AGENTS.md`, and reconstructs the
current operating state from repository evidence alone.

### When it runs

Run the trial when Dale explicitly requests it or when Dale elects to switch the
active implementation surface and wants portability proven. It is read-only and
blocks nothing unless Dale explicitly makes it a gate for that switch.

Structural readiness is not a PASS. Do not perform or simulate the trial from a
session that already has Atlas Financial history and then claim portability was
proven.

Launch it with exactly this prompt:

> Read `AGENTS.md` and perform the documented Atlas Financial fresh-agent
> cold-start acceptance trial. Make no edits, create no branch, access no raw
> financial source, and invoke no live institution or production write. Report
> the required evidence and stop.

### Required report

The fresh agent reports all ten items:

1. current `main` SHA;
2. whether any open pull request overlaps the next outcome;
3. the current source of work — explicit owner instruction if supplied,
   otherwise the build strategy;
4. the first eligible action, or the exact blocker — eligibility as the build
   strategy defines it, which does not exclude an item merely because no phase
   names it;
5. every owner-reserved stop relevant to that action;
6. the required new-branch rule: fresh current `main`, prefer
   `agent/<outcome>`, with a provider-enforced namespace allowed only under
   **Branch naming compatibility**;
7. the applicable deterministic test commands named by current repository
   governance for that action;
8. what independent proof is required if a household-facing financial figure is
   touched;
9. whether the Atlas Contract / Systems Review would be required for the
   identified action and why; and
10. what the agent is explicitly forbidden to do next without a new
    authorization or without leaving read-only trial mode.

### Trial bounds

The trial:

- makes no file edit or commit;
- creates no branch or pull request;
- changes no deployment or configuration;
- accesses no `raw/` or `derived/` financial source;
- requests or handles no institution credential;
- invokes no institution action and no production write;
- does not merge, approve, or advance an owner-reserved gate.

### Verdict

A PASS is claimed only after a real fresh agent performs the trial and reports
all ten items correctly from repository state. A missing or wrong item is a
portability/documentation defect: fix the smallest relevant canonical document,
then run the real trial again if Dale still wants the proof.

## Forced mid-PR handoff

Avoid switching builders mid-PR. When unavoidable, the outgoing agent leaves
these facts in the pull request body or a top-level pull-request comment:

1. source and one independently provable outcome;
2. exact current head SHA and base SHA;
3. Current-State Verification Gate verdict and root cause/authority boundary;
4. files changed and remaining work;
5. tests and independent proof already run, including failures and unrun gates;
6. owner authorization, household fact, live evidence, or review still required;
   and
7. every unresolved real high-severity/systemic finding.

The incoming agent re-verifies all seven against the diff, tests, current
repository state, and canonical documents before continuing. A prose handoff
never outranks the repository.

## Review and merge portability

GitHub Actions and deterministic checks remain the hard mechanical gates.
Independent agent review remains optional/advisory unless `CLAUDE.md` says a
real defect itself blocks. The trigger-based Atlas Contract / Systems Review is
separate and is performed by ChatGPT when required.

A builder never satisfies the required architecture review with its own
clean-context pass, and a surface switch never converts an owner-reserved item
into agent authority.

## Non-goals

This document does **not**:

- create another roadmap, backlog, architecture, merge policy, or review lane;
- authorize a bank/data integration, database, schema, credential, production
  write, destructive operation, or raw-data movement;
- lower the independent-proof requirement for financial figures;
- require multiple agents to work in parallel; or
- require a fresh-agent trial before ordinary work unless Dale explicitly makes
  that trial a gate for a surface switch.

Portability means **the same bounded system survives a builder/model change**.
It does not mean more process.