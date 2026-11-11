# Atlas Financial — agent brief

## Sprint to Atlas 1.0 (owner decision, Dale, 2026-11-02)

Until #821 items 1–7 are done, this section overrides the process parts of
this file. Where it and later process text conflict, this section wins until
1.0. The safety, data, credential and owner-reserved rules below are unchanged
and still bind.

**Finish line.** Atlas 1.0 = #821 items 1–7, frozen. Item 8 (#822) is optional
and last. New ideas go to the "After 1.0" list in `BACKLOG.md`. No new
foundations, governance or check machinery unless it blocks a 1.0 item.

**Roles**

- **Dale (owner):** household facts and owner-reserved stops only. Standing
  rule: if the asker has a clear recommendation, do not ask Dale; act on it and
  tell him.
- **Claude Code (lead):** owns the 1.0 order, builds, coordinates, and picks
  models per task.
- **ChatGPT (Atlas):** reviewer of record for figure-moving changes, with one
  bounded review; also the second builder, one 1.0 item at a time. Desk rulings
  only when the lead asks.
- **Muse:** merger under the merge gate, plus routine monitoring. Planning and
  dispatch move to the lead.
- **Grok (Grok Bot):** owns the ledger-side work, under rule 17 below. Grok
  building in this repository stays paused until 1.0.
- **Codex, Astra:** paused until 1.0. The lead may call on Astra for a
  specific hard task, with Dale's okay.
- Nobody reviews or merges their own build. Atlas never merges.
- **Backup merger:** under the 10-minute Merge fallback and the full Merge
  gate, a Claude Code session may merge a PR built by a different Claude Code
  session, if it neither built the PR nor authored its review findings and the
  exact-head review is by another agent or session. Dispatching a build is not
  building it. Muse stays the default merger; Atlas never merges. (Muse itself
  merges as soon as the gate completes, #787 6630392842.)

**Rules**

1. Safety rules are unchanged (see "Absolute data safety", "What not to build"
   and "Owner-reserved stops").
2. A figure-moving change gets one independent review — by Atlas; if Atlas
   built it, by Muse (or Claude Code if Muse built part of it; Dale,
   2026-11-09, to save Claude usage) — with
   factual findings on the exact head, then merges.
3. Everything else gets one independent check, then merges on green.
4. Before any merge, the PR merge-ref run (against current `main`) is green on
   the exact head, and the PR is up to date with `main`.
5. Do not merge while an owner question on that PR is open.
6. One repair round after a blocker; if it is still blocked, the lead decides
   scope or design. No loops.
7. Owner questions go to Dale as one short message, one decision.
8. The PR is the record. Slack only for "needs you" and "done". No claim
   windows, adoption timers or sweep notices.
9. A weekly plain-words owner report: what is new for Dale, and the steps
   remaining per #821 item.
10. Repository visibility stays public for now by owner decision; this does not
    relax the no-household-figures-in-GitHub rule.

**Pace rules** (owner decision, Dale, 2026-11-08, after the 2026-11-07/08
blitz). Rules 11–15 narrow the rules above; they loosen nothing. Rule 16 is
the one owner-decided loosening, limited to exactly the case it names.

11. **No bundles.** Each PR merges on its own through the merge queue after
    its own review; rollups are retired (Dale, 2026-11-08, once the queue
    merged #867). A PR that conflicts with main is caught up by its own
    builder, never folded into another PR.
12. **One merge list.** The lead keeps one pinned "Merge line" comment on #821:
    each PR, its exact head and its next step. Muse merges only a PR and head
    on that list. Slack points to the list; it does not restate it.
13. **Frozen heads.** Once review is requested, the builder pushes only after a
    `BLOCKERS FOUND` record or the lead's ask, and tells the lead. Immediately
    before merging, the merger confirms the PR's head equals the listed head,
    and that it is the reviewed head or a clean GitHub update of it with no
    hand-resolved files; on any mismatch it stops.
14. **Current address only.** New sessions start on
    `Atlas-Financal/Atlas-Financial`. Sessions tied to the old address finish
    their open PR and retire. No new builders while the merge list holds
    unfinished in-flight work.
15. **Real page, privately.** A figure-moving change is not reported as done
    until its effect has been checked against the household's real data on
    the private route, with nothing posted to GitHub. After each batch that
    moves figures lands, the lead asks Dale for one walk of the live Budget
    page against the bank.
16. **Prior approval counts as the figures look** (owner decision, Dale,
    2026-11-09). On a figures-moved PR, Dale's earlier direct approval of the
    exact change stands in for his separate figures look only when all of
    these hold on the exact base and head: the private diff
    (`docs/PRIVATE_FIGURES_REVIEW.md`) shows 0 household fields moved; every
    moved field is on an invented input and is the change the card states; a
    non-builder records that disposition on the PR; and the PR records
    Dale's direct approval of that change. Otherwise his look is required as
    before. If the head moves, the private diff is re-run on the new exact
    base and head before rule 16 can apply. Rule 15 is unchanged.

**Ledger rule** (owner decision, Dale, 2026-11-11; recorded on #821
6804776747 and 6805059178).

17. **Grok Bot owns the ledger-side work.** That is: transaction sorting,
    transaction naming, Lunch Money rules, bill-payment confirmation,
    subscriptions and income confirmation. Atlas reads what the Lunch Money
    ledger says (category, note, name) and shows it. Every lead, builder and
    reviewer defers to Grok Bot on these. Grok Bot writes no code here: the
    lead tells Grok Bot, in the Plan #6 Slack thread, what the team wants to
    do, and Grok Bot answers. A change that touches any of these areas is
    built, repaired, reviewed or merged only after that answer, and only as
    Grok Bot agreed; the approved builders still do the building. When unsure
    whether a change touches these, ask Grok Bot.
    This loosens no safety rule: Atlas stays read-only against banks and
    Lunch Money apart from the grants [`ARCHITECTURE.md`](ARCHITECTURE.md)
    records, and nobody handles credentials.

The merge card and its CI checks (`merge-card-check`, risk label) stay as they
are.

---

**Who decides, who reviews, and when something stops for a person.**

This file holds the operating, review and merge rules. Its filename is retained
for historical continuity; it binds every approved implementation surface and
model equally. It deliberately holds nothing else, because the rest already has
a home:

| For | Read |
|---|---|
| Orientation in a new session | [`CONTEXT.md`](CONTEXT.md) |
| Builder portability and repository-state handoff | [`docs/BUILDER_PORTABILITY.md`](docs/BUILDER_PORTABILITY.md) |
| How the layers fit together, and the direction | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| What the CI gates check and why each exists | [`docs/RISK_LABELS.md`](docs/RISK_LABELS.md) |
| Work that can be done | [`BACKLOG.md`](BACKLOG.md) |
| What only the household can answer | [`docs/01_OPEN_QUESTIONS.md`](docs/01_OPEN_QUESTIONS.md) |
| What to build next, and in what order | [`docs/ATLAS_FINANCIAL_BUILD_STRATEGY.md`](docs/ATLAS_FINANCIAL_BUILD_STRATEGY.md) |
| Task procedure (load on demand) | [`docs/skills/README.md`](docs/skills/README.md) |
| Durable technical lessons (non-authoritative; search, do not always-load) | [`docs/lessons/README.md`](docs/lessons/README.md) |
| Agent context architecture | [`docs/AGENT_CONTEXT.md`](docs/AGENT_CONTEXT.md) |

One fact, one home. Where this file and one of those appear to disagree about a
mechanism, that file is right about the mechanism and this one is right about
the authority.

## The failure mode this governs

Nothing here serves traffic, holds a queue or takes a payment. The damage this
repository can do is quieter: it publishes a number, a household reads it, and
acts on it. A figure that is wrong and looks plausible does more harm than a
crash, because a crash gets noticed.

Review here is therefore never "does the code work". It is **is this true, and
does one fact still have one home**.

---

## Roles

### Dale — owner

Dale owns the household facts, the direction, and anything that cannot be
derived from what is already in the repository: whether a figure may be
presented as verified, what happens to raw statements, credentials and secrets,
what the site is for, and which tier of `ARCHITECTURE.md` is entered next.

Dale may merge anything, or withdraw any of the authority below. Routine work
does not wait for him to click merge — see **Merge policy**.

### The decision desk, and the Atlas Contract / Systems Review — ChatGPT

ChatGPT does two separate things, and they should not be confused.

1. **The decision desk** helps Dale resolve genuinely non-derivable product,
   scope and trust forks. It never answers a household fact — those are
   questions for the household and live in `docs/01_OPEN_QUESTIONS.md` — and it
   never holds work items, which live in `BACKLOG.md`.
2. **The Atlas Contract / Systems Review** — as Atlas, ChatGPT is the default
   reviewer of record. It reads a pull request's exact head and publishes
   factual findings, never a PASS, an approval, or merge permission. It reviews
   every figures-moved pull request it did not build. It does not make merge
   decisions. The review contract is defined below.

The decision desk is accountable for usable completion. It owns the
distance-to-live path (below) and finishes or formally retires the missing
links on it; reviewing for danger does not discharge that accountability, and
inactive foundations must not accumulate without an owner and a next action.

**Use one name for the lane everywhere.** Two names for one lane read as two
lanes.

### The approved active implementation agent

The agent Dale has approved to build a given outcome — the pull request's
builder. It is a role, not a product name. Approved builders are currently
Claude Code (main), Atlas, Muse occasionally, and Grok when usage allows; Codex,
Cursor or another owner-approved surface may hold the role, running whichever
model that surface runs.

The surface and the model change nothing — not the branch rules, the
one-outcome rule, the verification gate, the review contract, the
owner-reserved stops, or merge authority. Two agents never hold the role for the
same outcome at the same time.

The agent selects the work, verifies current state before editing, implements
one independently provable outcome on a fresh `agent/<outcome>` branch from
current `main`, proves the numbers independently, opens the pull request with
the merge card filled, and addresses any real high-severity advisory defect.
Before handback it obtains one independent pre-review, repairs the real
blockers, and records dispositions, without an endless polish loop. An
automated pre-review record posted by `.github/workflows/claude-pre-review.yml`
on the exact current head counts as the builder's independent pre-review for a
light-lane pull request; it never replaces the Atlas Contract / Systems Review,
never counts as an owner decision, and a `BLOCKERS FOUND` from it is treated
like any other pre-review blocker. When a
high-risk trigger has fired, it requests the Atlas Contract / Systems Review
only after the head is a stable merge candidate. **Nobody reviews or merges
their own build:** the builder hands back and a merger decides.

### Independent agent review — any agent that is not the active builder

Any agent that is not the pull request's builder may review. Atlas is the
default reviewer and reviews every figures-moved pull request, so money logic
meets one consistent standard. Lower-risk pull requests, and Atlas-built pull
requests, may be reviewed by Claude Code or Muse; an Atlas-built figures-moved
pull request is reviewed by Muse (or Claude Code if Muse built part of it). When
Muse reviewed a pull request, it does not also merge it; the backup merger does.
Every reviewer uses the same
factual findings record (below).

Improvement suggestions stay advisory. Fix the real findings, say why for the
ones you reject, and record both in the merge card. Never manufacture a review
status out of a bot's wording, its reactions, or its identity.

### Merger — any agent that is not the builder, except Atlas

Only the agents named here make and record merge decisions, and never on a pull
request they built. Atlas reviews only and never merges. Muse (dispatcher) is
the default merger. Claude Code is the backup merger under Dale's standing
approval, for pull requests it did not build: when Muse asks, or through the
10-minute **Merge fallback** below. Grok does not merge for now. If no eligible
merger is available, the pull request waits. The merger decides under
Dale's standing instructions and treats review findings as evidence, not as
delegated permission — see **Merge gate**.

### Review routing and claims — no per-review dispatch

Routine review and merge run by rule; the dispatcher steps in only on
exceptions. Extended 2026-10-30 (owner).

- **Default reviewer, named by the builder in its REVIEW READY post:**
  a figures-moved pull request not built by Atlas → Atlas; an Atlas-built pull
  request → Muse (Claude Code if Muse built part of it); a lower-risk
  pull request built by Claude Code → Atlas, or Muse if Atlas is unavailable; a
  Muse-built pull request → Atlas.
- **Claim before reviewing:** the reviewer posts `Reviewing #<n> at <full head
  SHA>` in the assignment thread before starting. The first claim owns the
  review. If no review is claimed within 30 minutes of REVIEW READY, the
  dispatcher assigns a reviewer.
- **Merge fallback:** Muse merges by default. The 10-minute clock (Dale,
  2026-11-09; previously 30) starts when
  the exact head first has both green required checks and a `NO BLOCKERS FOUND`
  review. If Muse has not merged by then, the backup merger (Claude Code, never for its own
  build) may merge after the same **Merge gate** verification.
- **The dispatcher still owns build-side coordination:** what is built, by
  whom, in what order, and file reservations. It handles unclaimed reviews,
  stalled merges and conflicts.


### GitHub Actions

The deterministic hard gates. A required check that is missing, stale, skipped,
errored, timed out, cancelled or failed **is a failure**, not an absence of one.

---

## The two review lanes

|  | Atlas Contract / Systems Review | Independent improvement audit |
|---|---|---|
| Performed by | Atlas (ChatGPT) by default; another non-builder where allowed below | An agent that is not the active builder |
| Status | **Required only when a high-risk trigger fires** | Optional |
| Question | Is this exact head unsafe or architecturally wrong to merge? | What could be improved? |
| Result | Factual findings: `BLOCKERS FOUND`, `NO BLOCKERS FOUND`, or `INCOMPLETE` | Findings with dispositions |
| Is it a GitHub check? | No | No |

The lanes are separate. An improvement does not become a blocker because a
reviewer noticed it. A real product, financial, security, authority, or trust
defect remains a blocker because the defect is real.

### Atlas Contract / Systems Review — blocking architecture review

> Amended 2026-10-30 (owner decision; #787 6531025470): formal PASS retired;
> reviews are factual findings; Muse owns merge decisions. Extended 2026-10-30
> (owner): any non-builder agent except Atlas may decide merges; any non-builder
> may review; Atlas reviews figures-moved PRs. Historical PASS records remain as
> history.

**Atlas (ChatGPT) performs this review by default**, and always for a
figures-moved pull request it did not build; that is the only case where Atlas
is the required reviewer (owner scope, 2026-10-30). Any other pull request,
including one with a non-figures high-risk trigger, or an Atlas-built pull
request may instead be reviewed by Claude Code or Muse. A Grok-built pull
request goes to Atlas by default. When a high-risk trigger
fires, the review is required governance before merge. When no high-risk
trigger fires, it is not required. The active implementation agent cannot
satisfy its own architecture gate. The review is not a GitHub status check. It
never authorizes a household fact, raw data release, secret, schema, production
write, or promotion from estimated to verified. Those remain owner-reserved.
The review publishes factual findings; it is not a PASS, a GitHub APPROVE, or
merge authorization.

#### High-risk triggers

The review is required only when a pull request changes one of these:

- runtime logic that computes or publishes a figure the household acts on;
- the independent numerical/invariant proof that permits that logic to merge,
  when the change removes, disables or narrows that proof;
- the sole authority for a fact, figure, engine decision, security boundary, or
  store, including a cutover, compatibility bridge, or bridge sunset;
- authentication, sessions, cookies, CSP, secret handling, raw-data boundaries,
  a schema, a production write path, or a destructive operation;
- the verified / calculated / estimated / unknown trust contract, an estimate
  reaching a decision surface, or a claim being promoted to verified;
- an owner-reserved gate, product direction, or the product trust contract;
- a deterministic hard gate whose pass/fail result protects one of the items
  above, when the change removes, disables or narrows that protection; or
- unresolved ambiguity about one of the items above.

Ordinary documentation or status precision does not trigger the review when it
records current state without moving an authority or trust claim. Neither do
routine tests, refactors, templates, or comments that leave runtime and hard-gate
semantics unchanged.

#### Review lanes, finish lines and rulings

> Owner decision, Dale, 2026-11-02 (Plan #6 thread, recorded by Claude Code at
> his request): right-size the process to the risk.

- **Full lane.** A pull request with a high-risk trigger above follows this
  file as written: Atlas Contract / Systems Review, the desk where a design
  question arises, and the merge gate.
- **Which rule wins.** Any high-risk trigger above puts a pull request in the
  full lane; the light lane never overrides one. Security and privacy guards
  (the pre-commit and secret hooks, `privacy-guard`, authentication, sessions,
  CSP and the raw-data boundary) are always full lane, and owner-reserved stop
  4 is unchanged.
- **Light lane.** Everything else, including review and check machinery
  (tests, validators, page capture, the figures checks) that adds, tightens or
  repairs a check without changing how any figure is calculated or published.
  A repair must preserve the protected failure coverage and the proof's
  independence, including its execution and skip conditions (a legitimate
  false-positive repair may let safe cases through); when that is uncertain,
  the full lane applies.
  One builder and one independent reviewer (the builder's independent
  pre-review counts); the merger merges on green with no blocker. No desk
  return and no advisory pass unless the owner or Muse asks for one. A
  light-lane change that turns out to fire any high-risk trigger above moves
  to the full lane.
- **Finish line first.** Every dispatch states, before building, its
  acceptance condition and what is out of scope. A failure inside that
  boundary blocks. A finding outside it takes a **Finding disposition** (with
  any named limit explained there), not a blocker, unless Muse expands the
  scope. The finish line
  never defers a genuine financial, security, authority, invariant, product or
  trust defect in the change under review or introduced by it: that still
  blocks under the **Merge gate**. A pre-existing defect elsewhere takes a
  **Finding disposition** as usual.
- **Rulings adopt by default.** A reviewer's desk ruling counts as adopted
  unless Muse objects within two hours of its being posted in the assignment
  thread with notice to Muse; a material revision restarts the clock. Muse still issues
  START for builds and still decides merges. A ruling that touches an
  owner-reserved item never adopts by default: it waits for the owner.

#### When the review is requested

Do not request this review until the pull request is a credible merge
candidate:

- implementation is complete;
- the merge card is current;
- the fast checks on the exact head (merge card, risk label, privacy guard)
  are green, and the remaining required checks are green, queued or still
  running on that same head (Dale, 2026-11-09: review overlaps the long suites);
- figures review has completed when applicable, or is still running on that
  head, in which case the review record names it as pending;
- the builder's independent pre-review has completed, with real blockers
  repaired and dispositions recorded;
- one optional independent advisory pass, if run, has completed;
- genuine high-severity advisory findings have already been repaired; and
- the head is expected to stay stable.

If a required check then fails, or a figures report that was pending does
not match the merge card, the builder tells the lead and, on the lead's ask
(rule 13), repairs it; the review that follows is the bounded re-review of the
repair. Nothing merges until every required check is green on the exact
reviewed head (Merge gate). The reviewer
reviews a candidate for merge, not the first implementation
attempt. Optional advisory suggestions need not all be fixed.
Correct-but-improvable work may proceed to systems review.

The builder must deliver the review request directly to the named reviewer —
for Atlas, the active ChatGPT decision-desk session — with the pull request
number and current full head SHA.
A GitHub review, comment, label, or workflow run is evidence only: it cannot
wake ChatGPT and does not start or satisfy this review. Paid OpenAI reviewer
workflows are retired. Do not wait for them.

#### Bounded review protocol

The blocking question is one sentence:

> Is this exact head unsafe or architecturally wrong to merge?

The initial review reports only merge blockers. It checks one-authority
ownership, false-green proof, numerical/trust invariants, security and owner
boundaries, and bridge cleanup. Correct-but-improvable work is recorded as
`NO BLOCKERS FOUND`; any improvement notes are labelled non-blocking
observations or go to the optional audit.

If the findings are `BLOCKERS FOUND`, the pull request returns to the named
builder: repair only the named blockers and prove those repairs with targeted
tests plus the normal applicable checks.

A repair also inspects the same failure class across the surface it touches,
and its tests distinguish the class, not only the reported example. Unrelated
refactoring stays out of scope. When the blocker-after-blocker stop below
triggers, the builder records the disposition in the pull request as three
short lines — invariant, cause, affected boundary — and waits for the desk's
reassessment instead of pushing another repair. Then request
bounded re-review on the new exact head. The follow-up reads that head, verifies
the named fixes, and checks the high-risk surface changed by those repairs. It
does **not** reopen the untouched artifact for an unlimited new review. A new
blocker is in scope only when the fix introduced a new high-severity defect,
changed another high-risk surface, or made the original blocker impossible to
verify without that adjacent fact.

If a review repair itself introduces another genuine high-risk blocker, one
bounded repair is reasonable. If the process then continues producing
blocker-after-blocker, stop the automation and review churn and return the
design or process to the decision desk for reassessment. Do not create an
endless repair / re-review loop.

There is no target number of rounds and no "run until clean" rule. The terminal
result is `NO BLOCKERS FOUND` on the current exact head when no unsafe or
architecturally wrong condition remains. That is evidence for the merger, not
merge authorization.

#### Factual findings record

Every reviewer, on every pull request, records its findings as a PR comment in
this form:

```
Reviewed head: <full 40-character head SHA>
Findings: BLOCKERS FOUND | NO BLOCKERS FOUND | INCOMPLETE
```

followed by numbered blocking findings with evidence, the verification
performed, scope and limitations, and separately labelled non-blocking
observations. A no-blocker record states "No blockers identified within the
reviewed scope." Every record includes: "Factual review findings only; not
formal PR approval or merge authorization. Applies only to the reviewed SHA."

Use no PASS or APPROVE vocabulary and claim no guaranteed correctness. A review
that could not cover its scope is `INCOMPLETE`, never `NO BLOCKERS FOUND`.
`BLOCKERS FOUND` returns the pull request to the named builder. Silence is not
review evidence. Historical `PASS` / `BLOCKING` / `NOT PASS` records remain
valid history.

#### Merge-card record

The review block records five fields:

- **Required** — opens `REQUIRED` or `NOT REQUIRED`;
- **Exact reviewed head** — the current full SHA when required, else `N/A`;
- **Reviewer** — the non-builder reviewer (for example `Atlas`) when required,
  else `N/A`;
- **Review outcome** — `BLOCKERS FOUND`, `NO BLOCKERS FOUND`, `INCOMPLETE`, or
  `PENDING` when required, else `N/A`; and
- **Findings and fix verification** — the findings record, blocker
  dispositions and follow-up verification, or `N/A`.

The reviewer's PR comment is the findings record; the card mirrors it. When the
review is required, the merger waits for `NO BLOCKERS FOUND` covering the current
exact head. That wait is a review contract, not a GitHub status check.

`merge-card-check` enforces only that the card is filled and the closed openings
are structurally valid. It does **not** parse or enforce reviewer identity, the
outcome value, or review-SHA equality, and it authenticates nothing. Confidence
that the change is not junk comes from `npm test`, the secret hook, and the
figures comment. Decision-desk advice from ChatGPT remains optional and is a
separate role from this review.

#### Recording findings and the merge decision

Findings and the merge decision are separate records made by separate agents.
The reviewer records its findings as a PR comment naming the reviewed head. The
merger records its own merge decision on the pull request, naming the head it
merged and the findings it relied on. The builder writes neither.

Provenance comes from the existing review handoff and verified session
provenance. A shared-account "From Atlas" or "From Dale" label is attribution,
not authentication; when provenance is uncertain, verify with the actual
reviewer or owner rather than treat the text as authenticated.

A connector or safety-layer write failure does not change completed findings:
it does not turn `NO BLOCKERS FOUND` into `BLOCKERS FOUND` or "re-review
pending", and it does not authorize another code repair. If the reviewer has
completed findings on the current full SHA but cannot write to GitHub:

1. preserve that exact head; do not ask the builder to change code or rerun the
   repair loop;
2. one owner-approved non-builder agent may **clerically transcribe** the completed findings into
   a PR comment and the Merge Card review block, without deciding, upgrading,
   downgrading, or materially rewriting them; and
3. the transcription notes that the reviewer completed the exact-head review and
   that its normal write was blocked.

A transcription is not a second review and grants the transcribing agent no
review or merge authority. It may not infer findings from CI, bot reactions, a
relayed statement, a prior head, or silence. If the head moves, the old findings
cannot be transcribed onto the new head. If the PR write is also blocked, stop
and notify the merger once; do not loop on recording attempts, and do not merge
on unrecorded findings. `BLOCKERS FOUND` remains a code blocker even if its
recording write fails.

### Independent improvement audit — optional and bounded

In the light lane, no advisory pass is run unless the owner or Muse asks for
one (repository review bots that run automatically on every pull request are
not an advisory pass; their findings are dispositioned as usual). In the full lane, default to at most **one advisory pass** on a coherent head. Do not request a
second pass because ordinary fixes made the first pass stale. A second pass is
justified only when the first found a high-severity or systemic defect, or the
response materially changed a high-risk runtime, security, schema, authority,
cutover, or product-trust surface.

Lower-severity improvements may be accepted, rejected with a short reason, or
routed. They do not require another audit. `not run` is a valid merge-card
answer. An unresolved high-severity product/trust defect still blocks, but the
blocker is the defect, not the existence or freshness of an advisory review.

---

## Merge gate

The merger — never the pull request's builder, and never Atlas — makes and
records the merge decision under Dale's standing instructions. Review findings
are evidence; a reviewer's words are not delegated permission. Before merging,
the merger verifies all of these:

- `npm test` and the other hosted required GitHub checks succeeded **on the
  exact current head**;
- an independent review covers that exact head and no blocker or hold remains;
  a changed head needs the appropriate exact-head review, bounded to the
  rebase/repair changes and the high-risk surfaces they affect rather than
  repeating unrelated work;
- the merge card is complete, including attribution;
- exactly one primary risk value, taken from the Merge Card and projected onto
  the GitHub label (`docs/RISK_LABELS.md`);
- no real financial, security, authority, invariant, or product-trust blocker
  remains;
- one independently provable outcome, clean branch, no unrelated drift, no
  secret or raw data;
- no owner-reserved item is outstanding; and
- the head has not changed immediately before the merge.

When a high-risk trigger has fired, Atlas Contract / Systems Review findings of
`NO BLOCKERS FOUND` on the current exact head are also required governance
before merge. The builder cannot satisfy it. It is not a GitHub status check:
`merge-card-check` does not parse or enforce reviewer identity, the outcome
value, or review-SHA equality. `BLOCKERS FOUND` returns the pull request to the
named builder; `INCOMPLETE` stays with the reviewer to complete (the builder has
nothing to repair); silence is not review evidence. Dale's owner-reserved holds
and veto on high-stakes changes are unchanged.

When no high-risk trigger has fired, the systems review is not required; the
builder's independent pre-review is the review evidence and must cover the
current head. Decision-desk advice from ChatGPT remains optional help.
`auto-safe` work may still merge on green.

A review never supplies a missing household fact, and never supplies permission
for an action behind a financial-correctness, trust, privacy/security,
credential, spending, production/provider-write, or activation boundary —
including frozen ATLAS-080, any money movement, and Astra-specific approval.
Those holds are unchanged. This contract is not a blanket permission to cross a
platform's action-specific approval requirement.

Do not invent a generic owner-approval ceremony, and do not treat the retired
paid OpenAI reviewer as this review.

Automatic repair is suspended because confidential cross-job patch transport
is unavailable. The suspended workflows (`atlas-test-repair.yml`,
`codex-cursor-repair.yml`, `codex-cursor-repair-dispatch.yml`) were retired on
2026-11-03: they only held repair at exit 78 (`private-artifact-blocked`), and
their review-sync PR-body writer was keyed to the retired `PASS` / `NOT PASS`
markers. Failures remain failures. Repair requires a local fix, the normal
tests, and genuine review under the existing review rules. A repair must not
weaken a financial test.

Restoring automatic repair, or an automated review-block writer, requires a new,
separately reviewed implementation: private patch transport for repair, and the
factual findings record for review recording. Neither is restored by
re-adding the retired workflows, retrying, or configuring an existing secret.

## Merge policy

The Merge Card `Primary risk` row decides what the owner does. The GitHub
primary label is a projection of that row, not a second judgement.
`docs/RISK_LABELS.md` defines each closed value:

- **`auto-safe`** — no published figure moves. Merge on green when no
  systems-review trigger fired. No approval click. A high-risk trigger still
  waits for Atlas Contract / Systems Review `NO BLOCKERS FOUND` on the current
  head.
- **`figures-moved`** — Atlas reviews it, so money logic meets one standard.
  The owner sees the figures diff before the merge. That
  is a *look*, not a sign-off ritual: reconcile the bot's list against the card,
  and if they disagree, one of them is wrong.
  Public counts do not satisfy that look. Changed or missing-baseline reports
  withhold acceptance pending private exact-base/head figure-level reconciliation;
  [`docs/PRIVATE_FIGURES_REVIEW.md`](docs/PRIVATE_FIGURES_REVIEW.md) describes
  local evidence preparation without a public artifact or a new approval gate.
- **`owner-decision`** — blocked on a person, not on code.
- **`blocked`** — not mergeable as it stands.

For high-risk triggered work, green tests, a complete card, no real blocker,
and Atlas Contract / Systems Review `NO BLOCKERS FOUND` on the current head make
a merge candidate; the merger still makes the decision. GitHub remains the
repository source of truth; that review is recorded there, not enforced as
another required status check.

The owner never has to click approve to make a green, in-scope pull request
mergeable. Owner-reserved items are **gates on specific questions**, never merge
approvals.

## Merge-card attribution

Every pull request declares who did the work, in the merge card. It is the only
place — no commit trailer, no model registry, no tracking sheet beside it.

- **Builder surface** — the tool the work ran on;
- **Primary builder model** — the exact model name the surface displays;
- **Supporting / explore models** — every other model used and what it did, or
  `None`;
- **Architecture / dispatch authority** — who dispatched and architecturally
  owns the work, normally ChatGPT.

Record the model name the surface actually shows. **Never guess one.** If the
surface withholds its model identity, say exactly that. Attribution is declared
evidence, not proof, and it grants no authority — it records who acted.

`None` is a real answer for supporting models alone. The other three name a real
surface, a real model (or a plain statement that it is withheld), and a real
authority.

---

## Before editing — the Current-State Verification Gate

State, in the merge card:

1. **Source** — the backlog item, open question, or owner instruction behind
   this work.
2. **Verdict** — exactly one of `STILL BROKEN` · `ALREADY FIXED` ·
   `PARTIALLY FIXED` · `FIXED BUT UNTESTED` · `STALE-SUPERSEDED` ·
   `NEEDS OWNER ANSWER`.
3. **Evidence** — the exact file, function, figure or test, and how it was
   checked *on current `main`, before any change*.

If it is already fixed, do not manufacture code. If it is fixed but untested,
prove it rather than refactor it. For anything financial, the proof has to be
independent of the code that produces the answer — a test exercising the same
function proves consistency, not correctness.

## Branch and scope rules

**One pull request, one independently provable outcome.**

"One concern" was the older form of this rule and it is not enough. A concern is
a topic, and a topic stretches to fit whatever was found while working on it. An
outcome is something that either happened or did not, and it can be proved. A
pull request qualifies when it has all five:

1. one concrete outcome;
2. one root cause, or one authority boundary;
3. one acceptance condition a reader can state without opening the diff;
4. one level-correct proof;
5. explicit non-goals.

| One outcome | Too broad |
|---|---|
| Make pending card charges authoritative in day-0 revolving headroom | Make the 90-day plan correct |
| Correct the weekly-cap opening gap, and prove every cash event is counted once | Improve the architecture |
| Make owner budget targets authoritative for the essential / discretionary split | Build the transaction system |

The right-hand column is not too *large*. It is unprovable: nothing about it can
come back green or red.

Then, unchanged in substance:

- Stage only intended files. Never `.env`, credentials, raw statements, derived
  output, or unrelated drift.
- The pre-commit hook is the safety net for local commits and it is never
  bypassed. GitHub API writes are judged by the same engine from the trusted
  default branch. If a fresh clone lost `core.hooksPath`, restore it before
  committing anything.

### Fresh `main`, surface-neutral branches, and the stacking exception

New implementation work uses `agent/<outcome>` on every surface. Existing
`claude/*` branches remain valid historical branches; do not rename them or use
them as evidence that new work is Claude-specific.

Every implementation pull request starts from current `main`. Later work is not
stacked on an open branch, and a merged branch is finished — follow-up work
restarts from `main`.

Stacking is an exception, and it needs a reason that survives being written
down: serial delivery from `main` would leave an incorrect intermediate
repository state, two live authorities, an unusable intermediate, or another
genuine atomicity problem. Convenience, speed, and "the files are already open"
are not reasons. When it is approved, the card records the dependency, the merge
order, the rebase or retarget step, and why serial delivery is unsafe.

### Scope budget — a tripwire, not a limit

Review tripwires, not rejection thresholds:

- **≤ 8 implementation files** — source, workflows, templates;
- **≤ ~600 changed implementation lines**;
- **tests, fixtures and generated output counted separately**, and stated
  separately;
- **one high-risk financial authority per pull request**, by preference.

Under or over them, a reviewer asks whether the pull request still has one
independently provable outcome. The tripwires are guidance, not merge-card
fields and not CI thresholds. Some honest work is large.

The numbers are gameable and the gaming is the thing to watch for: unrelated
code moved into one file, implementation hidden inside generated output, real
code labelled as a fixture, unrelated modules collapsed together. None of that
makes a pull request smaller; it makes the measurement wrong. Whether an
`EXCEEDED` pull request is still one outcome is the required review's call, not
the tripwire's.

### If it spreads, split it — and when it must not be split

Read the actual diff before marking a pull request ready. Crossing layers is
fine when one outcome needs all of them: engine plus tests plus a page plus the
document that states the rule is one pull request when the outcome is one. Work
discovered together is not one outcome because it was discovered together.

Several independently testable outcomes are several pull requests. Split them.

**The atomicity exception** goes the other way, and it is real: do not
manufacture a dishonest intermediate state just to make a pull request small. A
larger atomic pull request is right when splitting would leave two competing
live authorities, an incorrect published figure, a half-finished migration, a
weakened trust or safety invariant, or an unusable transition. The card records
`Atomicity exception: YES` and says what splitting would break, why the pieces
share one closure condition, and why this is safer than a sequence.

It is an exception. It is not a synonym for "these changes are related".

### Scope stays a reviewer judgement

Reviewers may ask for a split when a pull request contains independent outcomes.
They do not count review rounds or require a machine-readable reassessment. If a
fix reveals a separate outcome, route it. If splitting would create two live
authorities or an unsafe intermediate state, keep the atomic change together and
state why in ordinary prose.

## The Closed-Loop Delivery Contract

Every implementation pull request should be explainable as one chain:

**purpose → authority → implementation → integration → proof → cleanup →
closure.**

Work is finished when a loop is closed, not when code lands. Use the merge-card
reviewer-guidance section to state the outcome, non-goals, authority, consumer,
proof, and cleanup in concise prose. CI does not score or count them.

For every new production building block — a module, a derived figure, a script,
a workflow, a bridge — name:

- its **exact live consumer**, which exists;
- why it is needed **now**;
- how it is **integrated**;
- its **proof level**: unit proves local logic, integration proves wiring, a
  browser or full-session run proves the path a household actually reads, live
  proves the deployed system, owner evidence proves owner operation;
- whether it is **temporary or permanent**, and if temporary, the **exact**
  condition under which it is removed.

"Future flexibility", "useful foundation" and "might be useful later" are not
purposes. A foundation pull request is legitimate — it says
**FOUNDATION — NOT COMPLETION** and names the next consumer and the closure
step. What it may not do is call itself finished.

### Defect classification

Before fixing, classify — and record it in the card's **Authority impact** row,
which is already the home for what wins and what loses:

- **Local defect** — one owner is wrong. Fix that owner.
- **Authority defect** — two or more things decide the same concept. Choose one
  winner; remove the loser, derive it from the winner, or give it an exact
  sunset condition.
- **Missing capability** — nothing owns the concept. Add one owner, with a named
  consumer.

For an authority defect prefer **replace**, **derive**, **delete** — in that
order. Permanent reconciliation between two authorities is not a fix; it is the
defect with maintenance attached.

## Distance to live

For any multi-slice capability the household cannot yet use, the backlog holds
one ordered path to live. Every remaining step on the path names one
accountable owner and one next action. Progress is reported as distance
remaining on that path; a merged slice is not delivered capability and is
never reported as such. No new foundation work starts outside the path. A
slice proposed for the path names the launch gap it closes, its exact live
consumer, its owner, and its immediate integration step — the Closed-Loop
naming duties applied at selection time, before any code is written. When the
path changes materially, the owner hears it in the owner-decision format
below: what changed, and how far remains.

## Finding disposition

Anything found along the way takes exactly one disposition, recorded in the
card's **Additional findings** section. It does not silently expand the pull
request:

1. **FIXED NOW** — fixed and proved in this pull request.
2. **NEXT PR** — real, and the next pull request's outcome. Say what it is.
3. **REJECTED** — with the reason, in the pull request.
4. **ADDED TO BACKLOG** — an item in `BACKLOG.md`, named in the card.
5. **OWNER DECISION REQUIRED** — stop and ask. If it is something a human has to
   *know* rather than *do*, it is a question and belongs in
   `docs/01_OPEN_QUESTIONS.md`, not the backlog.

**FIXED NOW is the disposition that needs a test**, because it is the one that
grows the pull request. It is available when the finding shares this outcome's
root cause or authority boundary, or when this pull request cannot be correct or
honestly proven without it. Otherwise it is one of the other four.

*"While I'm here"* is not a reason. An advisory finding does not automatically
become work in this pull request either — classify it first. Dispositioning is
what makes any of this a decision rather than a drift.

## Agent autonomy

Inside a bounded pull request the active implementation agent has wide
latitude, and does not stop to ask permission to work. It may inspect,
reproduce, search, implement, refactor in scope, write tests — including
adversarial and mutation tests — fix in-scope defects, answer advisory review,
strengthen a proof, and update the documentation the outcome requires.

What it may not do is turn one pull request into another outcome.

**More autonomy through a smaller box, not through a bigger branch.** The box is
what makes the autonomy safe: a tightly bounded outcome can be reasoned about,
proved and reviewed on one head, so there is little left to ask about.

## Machines enforce structure; reviewers judge meaning

CI may enforce a fixed vocabulary, a field's presence, a SHA shape, equality to
the current head, an arithmetic identity, or another deterministic fact. CI may
not infer meaning from prose, negation, severity wording, scope arguments,
finding dispositions, or review-round narratives.

`merge-card-check` therefore checks required rows, the current-state opening,
and that the review decision opens `REQUIRED` or `NOT REQUIRED` with the closed
`N/A` fields when not required. It does not judge whether the human trigger
decision was correct, and it does not parse or enforce the review outcome value,
review-SHA equality, or reviewer identity. File paths are facts, not prose;
they are not a second review-status gate in this check. Small-PR discipline,
closed-loop delivery, advisory dispositions, and cleanup explanations remain
reviewer guidance.

## Governance-control lifecycle

Governance controls are retained, changed, or retired on evidence. They are not
grow-only.

A new hard control needs all four:

1. a demonstrated product or trust failure it would have caught;
2. a deterministic predicate with no prose interpretation;
3. a focused test that proves the predicate fails on the mechanical defect; and
4. a named retirement condition or reason it is permanent.

Review an existing control when it repeatedly blocks safe work, duplicates
another guard, or its original failure path disappears. Retire or narrow it when
another surviving control covers the demonstrated failure at least as directly,
or when the protected path no longer exists and a regression test proves that.
The governance PR states what is removed, what replaces its protection, and the
evidence. Retiring, disabling or narrowing a product/trust hard gate still
triggers the Atlas Contract / Systems Review. Owner-reserved production, schema, security, data, and
verification gates cannot be retired without the owner's explicit decision.

## Owner-reserved stops

Stop for Dale — do not infer approval — for:

1. a household fact only Dale or Amanda can supply;
2. presenting an estimate as verified, or changing how a figure is tagged
   toward more certainty (for example estimated or calculated to confirmed or
   verified). A change that only makes a tag more cautious (toward estimated,
   unknown or unavailable, or replacing an overstated tag with a more cautious
   one, never leaving a figure untagged) is not an owner stop; it still takes
   the full lane and its required review (Dale, 2026-11-09). Any other tag
   change, or one whose direction is unclear, stays an owner stop;
3. anything touching raw statements, credentials, secrets, or what leaves
   `raw/`;
4. security-relevant infrastructure: the auth gate, session handling, CSP, the
   pre-commit hook, repository visibility;
5. direction — the tiers in `ARCHITECTURE.md`, what the site is for, or adding a
   database, a bank integration or an aggregator;
6. a genuine unresolved conflict between two of these rules.

Routine analysis, tests, refactors, derivable wording, advisory disposition and
clean merges are **not** owner stops. Do not stop merely to report that a pull
request is ready to merge.

An owner decision reaches the owner as one short isolated message, labelled
as a decision: the single ask, the recommendation, the cost / access
consequences, and what it unblocks. Owner decisions are not buried inside
review threads and are not combined into packets. A decision the owner has
settled is recorded as settled and is not re-asked.

## Absolute data safety

- **Read-only against every bank and other financial institution.** No
  transfers, payments, applications, setting changes, form submissions or
  agreement acceptances. The 2026-09-04 Lunch Money exceptions in
  [`ARCHITECTURE.md`](ARCHITECTURE.md) are not bank actions: they
  authorize only the exhausted one-transaction `category_id` correction
  and the later reusable Other Spending `category_id` class. They do not
  open any other provider write.
- **Never ask for or handle an institution login credential.** A bank username or
  password, a PIN, a security answer, a one-time or 2FA code — anything that logs
  in as the household — is the owner's alone. On doubt, stop.
- `raw/` and `derived/` never enter git, a pull request, a comment, or a
  conversation. Only sanitised aggregates leave `raw/`.
- **A secret Atlas legitimately holds** — `SITE_PASSWORD`, `SESSION_SECRET`, and
  one day possibly an approved read-only provider token — lives only where
  [`ARCHITECTURE.md`](ARCHITECTURE.md) permits, and never in the repository, in
  `data.json`, in a pull request body, in a log, or delivered to or persisted in
  the browser. That file is the one home for the rule; do not restate a narrower
  version here.
- **Tag every figure** verified / calculated / estimated / unknown. An estimate
  is never presented as a verified fact.
- A contradiction between two published figures is a stop, not a footnote.

## Testing

```bash
npm test
```

Then whatever the change actually touches: `node test/test-forecast.js` after any
change to the `plan` block, `node test/test-local.js` after `server.js`,
`node test/test-mergecard.js` after the merge card check or the pull request
template, and `node verify-live.js` against the deployed site for the security
behaviour visible without a password.

**The review machinery is code, and it is tested like code.** A change to
`merge-card-check.yml` that nothing catches is a change to what may merge.

A test should prove the failure cannot recur through the path a household
actually reads — not only through the helper that was just written.

Every automated check names the concrete failure it detects and the release
decision its result can change. A check whose result can change no decision
is removed or demoted to advisory. Duplicated coverage of one failure is
consolidated, not repeated. A false positive is a defect in the check: repair
the check narrowly; never weaken the protection it implements because it
misfired once.

## What not to build

**Two absolutes, no gate, no exception:** never hold an **institution login
credential** — a bank username or password, a PIN, a security answer, a one-time
or 2FA code, or anything else meant for logging in as the household — and never
automate an action against a bank or other financial-institution account. Atlas
reads what it is given and publishes a private view. It does not move money,
submit a form, or accept an agreement. The 2026-09-04 Lunch Money
`category_id` grants are recorded in [`ARCHITECTURE.md`](ARCHITECTURE.md)
as the exhausted one-transaction correction and the later reusable Other
Spending class. They are not bank actions.

**On any doubt about a credential, stop.** If it could authenticate Atlas *as the
household* through an institution's ordinary login path, it is prohibited.
[`ARCHITECTURE.md`](ARCHITECTURE.md) states that fail-closed rule and is the one
home for it.

**Two gated capabilities:** a canonical store, and trusted canonical
refresh from live financial-data connectivity. The store is wanted and not
authorised. Live **read-only** Lunch Money observation already exists and
has been exercised. T4 passed 2026-08-17 for the earned preview/approve
writer (`scripts/canonical-refresh.js`). Automatic or unrestricted
production **writes** and scheduled refresh remain **not** authorised.
A production Lunch Money token is authorised for on-demand GET-only
observation as of 2026-08-23, plus the two 2026-09-04 `category_id`
grants [`ARCHITECTURE.md`](ARCHITECTURE.md) records: the exhausted
one-transaction correction, and the later reusable Other Spending
class. Neither grant makes the token a general Lunch Money write
credential. That file holds the exact gate for each capability. A capability is started when its gate is met
and Dale says so, not when a plan reaches that line. Owner-reserved stop
5 is unchanged. The 2026-08-17 Lunch Money feed decision is product
direction; the later same-day T4 pass is the write-gate pass with those
production reservations.

**Still nothing here:** no second dashboard, and no governance system beyond this
file. The gates that exist are the ones that caught something real. Add a gate
when something goes wrong that it would have caught, and not before.

**One roadmap, in three parts that do not overlap.**
[`ARCHITECTURE.md`](ARCHITECTURE.md) owns *direction, authority and the gates*;
[`docs/ATLAS_FINANCIAL_BUILD_STRATEGY.md`](docs/ATLAS_FINANCIAL_BUILD_STRATEGY.md)
owns *sequencing within what direction permits*; [`BACKLOG.md`](BACKLOG.md) owns
*work and findings*. A second one of any of those is the thing to refuse.
