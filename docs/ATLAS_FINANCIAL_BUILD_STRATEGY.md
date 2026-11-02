# Atlas Financial — build strategy

**The order work is done in, and what each piece has to prove.**

This document is **subordinate to [`ARCHITECTURE.md`](../ARCHITECTURE.md)**. That
file owns direction, which authority owns which concept, and the gate each future
capability must pass. This one owns *sequencing within what direction already
permits*. Where the two disagree, `ARCHITECTURE.md` wins and this file is wrong.

It also does not own work or findings. [`BACKLOG.md`](../BACKLOG.md) does, and
every item here names its backlog entry rather than restating it — including the
later-phase items, which are recorded there as `QUEUED` so the work record can
show them and their blockers rather than leaving them visible only here. A question only
the household can answer lives in
[`docs/01_OPEN_QUESTIONS.md`](01_OPEN_QUESTIONS.md).

**What this is not.** It is not a promise of completeness. It sequences the work
that is currently known and named; `BACKLOG.md` holds items this document has not
scheduled, and a backlog item is not ineligible merely because no phase names it.
Scheduling here authorises nothing that `ARCHITECTURE.md` has not already
permitted — reaching a line in this file passes no gate.

Capabilities that are wanted but not yet in Phases 1–4 are recorded in
**Later capabilities — status and reopen trigger**. That table is memory and
trigger, not a second order of work.

**Current sequencing (18 August 2026, after B79 closeout).**
B74, B80, B87–B90, B91, B92, B93, B94, B95, B96, B20, **B21 /
AF-INTAKE-01**, **B78 / AF-INGEST-01**, and **B79 / AF-STORE-01** are
closed. The live Lunch Money **read** observation test, the 2026-08-17
B21 refresh proof, the B78 identity/idempotency proof, and the B79
store-question answer have already happened; they are not future
milestones. Owner decision **2026-08-17**: Lunch Money is
the household's **normal operational financial update feed**. Forecast
remains the planner. Unattended production writes are **not** approved.
T3 is **met**. The store gate is **not** met: files remain the
foundation. **T4 passed 2026-08-17.** `B81` / `AF-LIVE-02` is **done** as the
earned preview / approve / bounded writer, the published 2026-08-19
canonical opening, and the read-only live overlay. Unattended production
writes, scheduled refresh, and a newer live substitute opening remain reserved. A production Lunch Money token is authorized for on-demand GET-only observation (2026-08-23), plus the two 2026-09-04 `category_id` grants recorded in `ARCHITECTURE.md` and the production pass: the exhausted one-transaction correction, and the later reusable Other Spending class. Neither grant is a canonical write credential. Do **not** wait for a second
month of routine statement files. Provider-completeness, broad historical
forensics, old categorisation cleanup, and file-statement backfill are
**not** critical-path gates unless they expose a demonstrated material
source or financial-correctness gap. Do not use `B81` to apply the unused
$10 Chequing B change.

---

## Atlas is not greenfield

Every item below either **consumes, evolves, derives from, replaces or deletes**
an existing authority, and says which. None stands a second one beside it.
`ARCHITECTURE.md`'s incumbent table is the list; this file cites it rather than
copying it, because a second copy would drift.

The dispositions used here:

| Disposition | Means |
|---|---|
| `CONSUME` | Uses an incumbent unchanged. |
| `EVOLVE` | Changes an incumbent in place; it stays the owner. |
| `DERIVE` | Produces something new *from* an incumbent, which stays the owner. |
| `REPLACE` | Retires an incumbent and names its successor. |
| `NEW` | Nothing owns the concept today; adds one owner with a named consumer. |

---

## Model tiers

Which agent capability an item needs, decided by **what it can get wrong**, not by
how much typing it involves.

| Tier | For work that | Requires |
|---|---|---|
| **M1** | touches no financial figure and moves no authority — housekeeping, comments, docs | the normal merge gate |
| **M2** | changes one named authority along a proof path that already exists | a test that fails before and passes after |
| **M3** | **moves, creates or retires a financial authority**, or changes what the household is told | proof **independent of the code under change**; this is on `CLAUDE.md`'s high-risk trigger list, so the blocking review applies |
| **M4** | cannot proceed without an owner decision or a household fact | the owner, before any code |

M3 is the tier that has hurt this repository. `Forecast.recommend` exists as *the*
single authority because two pieces of code once answered the same question and
the site published `$1,650/wk` beside `$0/wk`. A test exercising the function
under change proves consistency, not correctness — M3 needs a second path to the
same number.

**A tier is a floor, not a ceiling.** An item may be raised when the work turns
out to touch more than expected; it is never quietly lowered to move faster.

**A tier says what capability the work needs. It does not say whether the
blocking review applies** — that is decided separately by `CLAUDE.md`'s
high-risk trigger list, against what the pull request actually touches. **An M1 or
M2 item can trigger the review and several here do**, most obviously any item
that removes, disables or narrows a deterministic hard gate protecting an
authority (`CLAUDE.md` "Review lanes, finish lines and rulings"). Reading the tier
as the review answer is how an item skips a gate it should have met.

---

## Trajectory gates

Phase boundaries. Each is a condition on the repository, checked before the next
phase starts — not a date.

| Gate | Holds when |
|---|---|
| **T1** | Every financial answer the site publishes has a named owner reachable by `npm test`, and the authority record is mechanically checked rather than maintained by inspection. |
| **T2** | Account balances have history, so a trend question can be answered from the repository rather than from memory. **Met 2026-08-17** by the independently reconciled HELOC pair in `snapshots/2026-08-09.json` ($201,586.16) and `snapshots/2026-08-16.json` ($200,486.16): the stored history answers that the HELOC fell $1,100.00 between those openings. That is two dated openings, not a long-run monthly verdict. |
| **T3** | The **normal Lunch Money observation/import path** is **idempotent and identity-stable on real household data** — re-importing or re-observing changes nothing, and a corrected provider observation updates the same canonical target rather than duplicating. Uses existing Lunch Money provider account IDs / transaction IDs and the existing reconciliation architecture. Not a new identity system. **Met 2026-08-17** by B78: leftover 2026-08-16 owner-run observation replayed twice through the incumbent observer (identical fingerprint, MATCH 12 / CHANGE 0, no `data.json` write). Proof: [`docs/connectivity/LUNCH_MONEY_IDENTITY_PROOF_B78.md`](connectivity/LUNCH_MONEY_IDENTITY_PROOF_B78.md). |
| **T4** | Trusted **canonical refresh** from the live Lunch Money feed is permitted: `ARCHITECTURE.md`'s remaining connectivity conditions are met, and **the owner has passed the gate**. Live read-only observation already exists and has been exercised; T4 is not that GET. **Passed 2026-08-17.** Pass record: [`docs/connectivity/T4_OWNER_PASS_2026-08-17.md`](connectivity/T4_OWNER_PASS_2026-08-17.md). The pass authorizes the earned preview/approve writer, not unattended production writes. |

T1–T3 are conditions an agent can demonstrate. **T4 is an owner decision.**
It was passed on 2026-08-17 with the production reservations in the pass
record. Reaching T3 satisfied the identity/idempotency condition; the
owner pass opened the writer, not Render and not a scheduler.

---

## Owner-approved planning posture — 2026-08-11

The household does **not** need a forensic reconstruction of every historical
purchase before Atlas can plan. The captured history is already sufficient to
establish useful spending norms and build the current picture, subject to the
confidence rules below.

- **Historical unknowns stay in the money.** An unresolved transaction still
  counts in total spending and cash movement. Uncertainty changes category
  precision and confidence; it does not make the dollars disappear and does not
  block the budget or forecast by itself.
- **Material omissions are different.** A whole account, meaningful income
  stream, recurring obligation or other source gap that could materially change
  the plan is a correctness issue and may interrupt the sequence. Twenty old
  merchant labels are not the same thing as a missing credit card.
- **From now forward, clean the ledger as it arrives.** Every fresh Lunch Money
  observation should surface new unknown or ambiguous transactions for
  household clarification. Live read-only observation already exists; same-day
  automatic notification and automatic canonical writes still wait for the
  remaining connectivity gate rather than being faked by a polling architecture
  that is not yet authorised.
- **Household interviews are evidence, not silent policy.** Amanda's attributed
  interview can inform candidate assumptions, questions and scenarios. Nothing
  in it becomes a verified household fact or shared target merely because an
  agent can read it; promotion still needs the owner decision described in
  `ARCHITECTURE.md`.
- **The near-term product is the operating picture.** The current build should
  get to one trustworthy 13-week story, a week-by-week safe-to-spend view, one
  financial calendar, and the cash/debt consequence of known large commitments
  or owner-supplied planned purchases **before ingestion infrastructure becomes
  the centre of the work**.
- **Raw-source completeness is verification, not a standing gate.** `raw/`
  remains the immutable source and privacy boundary. A targeted local source
  audit is appropriate when reconciliation exposes a material gap; proving that
  every old file was consumed exactly once is not a prerequisite to using the
  captured history for planning.

These are planning assumptions, not permission to invent money. The existing
financial-correctness, provenance, security, one-authority and owner-reserved
boundaries remain unchanged.

---

## When an urgent finding may interrupt the order

`ARCHITECTURE.md` gives this file the order of planned capability work, and
`BACKLOG.md` feeds it rather than overriding it. That leaves one question, which
belongs here: **what may jump the queue.**

A finding pre-empts the current phase when **any** of these is true:

1. **a published figure is wrong** — the site is telling the household something
   untrue, or two published figures disagree;
2. **a data-safety or security boundary is breached** — anything touching `raw/`,
   a credential, a secret, or the auth gate;
3. **a gate's evidence has been falsified** — something this file or
   `ARCHITECTURE.md` relies on turns out not to hold, so the sequence is built on
   a false premise;
4. **a material source gap is demonstrated** — an omitted account, meaningful
   income stream or recurring obligation is likely to change the household plan.
   Ordinary historical categorisation uncertainty does not qualify.

Everything else — including work that is genuinely valuable and obviously next —
goes to `BACKLOG.md` and waits for its phase. "This is quick" and "we are already
in that file" are not entries on the list above.

**An interruption is still one pull request with one outcome.** It carries its own
merge card, records that it pre-empted and what it displaced, and does not absorb
the phase work it interrupted. Two interruptions do not merge into one.

**If a phase is interrupted more than twice**, the phase itself is the thing to
re-examine — repeated pre-emption usually means the sequence is wrong rather than
that the findings are unlucky.

---

## Post-B74 architecture disposition — 14 August 2026

Accepted sequencing after PR #37 merged, then updated the same day after
PR #42, three Claude architecture reviews, and the Aug. 14 payday test.
**Rebased 16 August 2026** after PR #81 (master-forecast contract), PR #82
(`B95` absorption), and the owner instruction that B80 plus the live Lunch
Money observation test are already done. This is not a second roadmap: it
**reorders work this file already owns**. `ARCHITECTURE.md` still owns
direction and gates — its master-forecast contract is already correct and
is not redesigned here. `BACKLOG.md` still owns the work items named
below. Dated advisory files remain evidence, not a competing sequence.

Governing principle: **Lunch Money is the normal operational update feed;
Forecast stays the planner; prove the existing observe → reconcile path on a
later live observation; then earn identity-stable import and trusted
canonical writes.** Do not create another architecture layer. Do not add a
second planner, a second reconciliation system, or a routine statement-import
prerequisite the owner has rejected.

The conversation audits that produced the earlier Post-B74 order were not
preserved as repository advisory files. The Aug. 14 payday corpus is
[`docs/source_intake/PAYDAY_ACCEPTANCE_2026-08-14.md`](source_intake/PAYDAY_ACCEPTANCE_2026-08-14.md).
This section is the accepted decision.

### What B74 closed — do not reopen

PR #37 gave the household cash schedule one Plan owner:

```
data.json plan
    ↓ Forecast.expandEvents
household cash schedule
    ├── Plan calendar
    ├── nextDue
    ├── nextPaymentOut
    └── ICS cash-payment VEVENTs

standing institutional facts
    ↓
reminder-only VEVENTs
```

Closed, and not to be reopened because an older audit described the pre-B74
state:

- multiple household cash-schedule authorities;
- `data.json upcoming` as a future schedule;
- hardcoded ICS cash-payment definitions;
- separate Plan / nextDue / nextPaymentOut cash calendars;
- RESP missing from the Plan cash path;
- union dues disappearing before confirmed cancellation;
- HELOC 21st represented as a chequing cash payment;
- fixed-five-month recurrence expansion.

Q19 remains intentionally open for HELOC household cash semantics. The 21st
stays reminder-only.

### Remaining order

Immediate correctness / cleanup is complete through `B90`. The two
refresh-cheap prerequisites (`B92`, `B93`) are complete. `B80` and the live
Lunch Money **read** observation test are complete — do not schedule them
again. `B95` absorbed the known major future costs onto the existing Plan.
History remains a by-product of successful refresh. Owner decision
**2026-08-17** replaces the earlier order that treated a second month of
routine statement files (`B21`) and file-based import (`B78`) as the normal
future path.

```
B87–B90, B92, B93                         ← complete
B80 + live Lunch Money read observation   ← complete; not a future milestone
B95  absorb known major future costs      ← complete (PR #82)
  ↓
B91  2026-08-16 current-state opening
     ← DONE; Aug. 14 corpus remains the distinction checklist
  ↓
B94 / AF-PLAN-01  master-forecast engine
     ← DONE; Forecast.knowledgeHorizon / fundingSequence /
       majorPlans / plannedDebt earned in place
  ↓
B96 / AF-PLAN-02  end-to-end payday proof
     ← DONE; household answer composed from Forecast
  ↓
B20 / AF-HIST-01  dated openings
     ← DONE; T2 met on the stored HELOC pair
  ↓
B21 / AF-INTAKE-01  prove the normal Lunch Money refresh path
     ← DONE 2026-08-17; sanitized proof in
       docs/connectivity/LUNCH_MONEY_REFRESH_PROOF_2026-08-17.md
  ↓
B78 / AF-INGEST-01  identity-stable idempotent Lunch Money
     observation/import on real household data (T3)
     ← DONE 2026-08-17; proof in
       docs/connectivity/LUNCH_MONEY_IDENTITY_PROOF_B78.md
  ↓
B79 / AF-STORE-01  the store question, answered by evidence
     ← DONE 2026-08-18; file foundation has not failed;
       proof in docs/STORE_QUESTION_B79.md; store gate stays closed
  ↓
B81 / AF-LIVE-02  trusted canonical refresh
     ← DONE; preview/approve/opening/recovery writers earned;
       published opening is 2026-08-19; read-only live overlay earned;
       production GET-only token authorized 2026-08-23;
       2026-09-04 category_id grants in ARCHITECTURE.md
       (exhausted one-transaction write, reusable Other Spending class);
       unattended production WRITE and a newer live
       substitute opening remain reserved
```

Not critical-path gates unless they expose a demonstrated material source
or financial-correctness gap: provider-completeness work, broad historical
forensics, old categorisation cleanup, and file-statement backfill.

**Product boundary, preserved:** ON TRACK / AT RISK / FUNDING GAP applies
to **major future plans**, not to individual transactions or budget
categories. Ordinary spending matters through its aggregate effect on the
household's ability to fund those plans.

Later items are not mechanically blocked by every earlier one. Agents must
still be able to tell the intended sequence. A published-figure, data-safety,
falsified-gate, or material-source-gap finding may still interrupt, per the
rules above.

### Immediate cleanup — not the major milestone

- **`AF-QSTAT-01` / `B87`** — one authority for OPEN / ANSWERED. **Complete.**
- **`AF-LINE-01` / `B88`** — tests must not spuriously depend on checkout
  line endings. **Complete.**
- **`AF-PUB-01` / `B89`** — where Atlas already has canonical inputs and
  deterministic derivation, do not store the result independently. Narrow;
  do not redesign `data.json`. **Complete.**
- **`AF-CLASS-01` / `B90`** — the same household spending category cannot
  silently tell contradictory essential/discretionary stories. Prefer a
  small guard. Preserve `business` and `reserve`. **Complete.**

### Next implementation outcomes — cheap refresh, then reconciliation

`B92` and `B93` are closed. `B80` and the live Lunch Money observation
test are closed. `B95` is closed. `B91` / `AF-RECON-01` is **DONE** and is
not a new architecture layer.

**`AF-TEST-01` / `B92`.** Make ordinary evidence refresh cheap. **Complete.**
Measured before the unpin, on throwaway clones: changing Chequing A broke 8
suites / 61 assertions; changing MBNA broke 5 / 19; removing Fusion camp
broke 6 / 18; changing payroll + Shaw broke 5 / 27. Behaviour tests no
longer pin live `data.json` cents.

**`AF-DEDUP-01` / `B93`.** Derive or delete proven duplicate live facts
before reconciliation is asked to keep them synchronised. **Complete.**
Cash balances live on `plan.startingCash` account rows; matching `assets[]`
rows keep label/order and a `cash` id. Overdraft `used` is
`max(0, −chequing-b)`. `debts[].balance` is the posted opening;
`postedBalance` is gone. Recurring historical `perMonth` is
`round(total / incomeCaptureMonths)`; the insurance one-off keeps
`perMonth: null`. Do not invent a permanent sync layer. Do not treat
`docs/positions.csv` as a universal fact database.

### Next major product milestone — evidence refresh / reconciliation

**`AF-RECON-01` / `B91`.** After `B92` and `B93`. The dominant remaining gap
is **fresh evidence → canonical household state**, not another calculation
engine. Forecast stays the deterministic financial engine. Connect existing
observation/extract records to existing canonical state with a small
non-writing reconciliation report:

```
existing observation record
    → one canonical pointer into data.json
    → comparison (MATCH / STALE / CHANGE / CONFLICT / MISSING)
    → owner-approved canonical edit
    → Forecast
    → payday-plan output
```

Owner approval remains required before evidence changes canonical household
financial policy or state where appropriate. First version covers a closed
set, not every field in `data.json`. Freshness belongs to the evidence
class (live balances, contractual recurring facts, household policy,
derived engine results), not merely one typed `meta.asOf`.

The Aug. 14 payday session is the closed acceptance corpus:
[`docs/source_intake/PAYDAY_ACCEPTANCE_2026-08-14.md`](source_intake/PAYDAY_ACCEPTANCE_2026-08-14.md).

**Do not build** a database; a second canonical store; a generic fact schema;
a workflow engine; event sourcing; a classification registry; a provenance
graph; a staging/approval platform; generated `data.json`; `plan.proposals[]`;
leaf-level `source` objects on every numeric field; another extraction
architecture; another forecast, recurrence, payday, or budgeting engine;
or a permanent manual synchronisation between duplicate facts. Do not lock
the loop to `docs/positions.csv` as a universal fact database. Preserve the
pointer-and-compare principle, not that exact file. The Evidence-Use
Register stays until this loop exists; do not delete it as the freshness
proof it is not. ChatGPT and Google Sheet consume Forecast output; they
are not authorities.

### After the refresh loop

- **`AF-PLAN-01` / `B94`** — the 2026-08-16 owner instruction established the
  master-forecast product contract in `ARCHITECTURE.md`. Engine work is the
  next critical-path item after a trustworthy `B91` opening. `B95` has
  already given the known major future costs one Plan home. Do not wait on
  `B20` / `B21`. Do not add a second engine. Do not mark `B91` done to make
  room.
- **`AF-PLAN-02` / `B96`** — after the engine exists, prove the payday
  question end-to-end from fresh evidence → canonical state → Forecast →
  household answer.
- **`AF-HIST-01` / `B20`** — **DONE 2026-08-17.** Balance history is a
  by-product of successful refresh: `scripts/snapshot-balances.js` writes
  `snapshots/<YYYY-MM-DD>.json` from canonical `data.json` plus same-date
  `positions.csv` rows. Not a critical-path gate.
- **`AF-INTAKE-01` / `B21`** — **DONE 2026-08-17.** Real-world proof of the
  **normal Lunch Money refresh path** on a later live observation. Not a
  second month of PDFs. Proof:
  [`docs/connectivity/LUNCH_MONEY_REFRESH_PROOF_2026-08-17.md`](connectivity/LUNCH_MONEY_REFRESH_PROOF_2026-08-17.md).
- **`AF-INGEST-01` / `B78`** — **DONE 2026-08-17.** Identity-stable,
  idempotent Lunch Money observation/import on real household data, using
  existing provider IDs and the existing reconciler. T3 met. Proof:
  [`docs/connectivity/LUNCH_MONEY_IDENTITY_PROOF_B78.md`](connectivity/LUNCH_MONEY_IDENTITY_PROOF_B78.md).
  At close, automatic canonical writes still waited on T4 / `B81`.

### Open governance question — do not solve here

Hard boundaries stay: financial and product correctness, security/privacy,
data integrity, production writes, destructive/schema changes, explicit owner
authority. Do not add governance machinery.

Accepted open question: **routine evidence / financial-state refresh may
eventually need a cheaper review lane than an engine authority change.**
`AF-RECON-01` should produce evidence about what ceremony is actually
necessary. Do not carve that lane in advance.

---

## AF-EVID-01 · Evidence-Use Register — Phase 1 interruption

Adopted from the August 13 recommendation after PR #27. This item interrupts
Phase 1 because captured evidence could sit unused with CI still green. B73
and B74 have since closed. The register remains routing-only: `CONSUMED` is
not a financial green, and does not prove value freshness. A later fold into
`AF-RECON-01` is the intended retirement path once that loop exists; do not
delete the register until then.

- **Outcome** — every explicitly identified evidence ID has exactly one
  CI-checked disposition against an existing incumbent. `CONSUMED` proves
  routing, not financial correctness.
- **Incumbent** — `NEW`. Consumes `docs/01_OPEN_QUESTIONS.md`, household
  interviews, `ARCHITECTURE.md`, and advisory records as destinations. Does
  **not** replace `Forecast`, `data.json` `plan`, ACCOUNT_FACTS, or published
  trust labels.
- **Tier** — **M3**. New architectural authority plus a deterministic hard
  gate. **Backlog** — `B85`.
- **Acceptance** — a governed ID with no disposition fails `npm test`; a
  `CONSUMED` pointer at a missing path fails; the suite does not compare
  amounts and does not claim semantic completeness of prose.
- **Non-goals** — payroll/HELOC/Fusion/budget figure fixes; B73/B74; a fact
  schema; generated `data.json`; a store; a copilot API.

---

## Phase 1 — make the current picture provable · to T1

The site already publishes figures the household acts on. Before anything is
built *on* that picture, the picture needs owners that a test can reach.

### AF-AUTH-01 · Make the authority record mechanically checkable

- **Outcome** — a check enumerates every named authority-producing surface and
  fails when one is absent from `ARCHITECTURE.md`'s incumbent table.
- **Incumbent** — the table itself, and the `npm test` suites. `EVOLVE`.
- **Tier** — M2, and it **triggers the blocking review**: it creates a deterministic hard gate whose pass/fail protects the authority record, which is on `CLAUDE.md`'s trigger list. Low complexity, high consequence. **Backlog** — `B75`.
- **Entry gate** — none; this is the first item.
- **Acceptance** — removing a row from the table fails the suite; adding a new
  `Forecast` export without a row fails the suite; the check states which
  surfaces it covers and does not claim completeness beyond them.
- **Prompt** — *Add a test that enumerates the authority-producing surfaces named
  in `B75` and asserts each appears in `ARCHITECTURE.md`'s incumbent table. Prove
  it by deleting a row and watching it fail. Claim coverage of the named
  surfaces, not completeness.*

### AF-AUTH-02 · Move page-script decisions into the engine

- **Outcome** — each financial decision recorded in `B73` is computed in a
  testable engine function; the page renders the result.
- **Incumbent** — `Forecast`, which gains the functions; `public/modellers.js`,
  `public/deepdive.js` and `public/plan.js`, which lose the arithmetic. `EVOLVE`.
- **Tier** — **M3**. These figures reach the household: the renewal comparison,
  the "Next due", the date Amanda's transfer is required by, the homepage
  mission, and the payoff modeller.
- **Backlog** — `B73`.
- **Entry gate** — AF-AUTH-01, so a new engine function cannot land unnamed.
- **Acceptance** — each moved decision reconciles against a **hand-computed case**
  rather than against the function that now produces it; the page renders and
  decides nothing; `B73` closes only after checking for instances beyond those
  recorded.
- **Prompt** — *Take one decision from `B73`. Move it into `public/forecast.js`,
  reconcile the result against a hand-computed case, and leave the page rendering
  only. One decision per pull request — five decisions is five outcomes.*
- **State** — **complete.** Every decision recorded in `B73` has moved,
  including the eight the 2026-08-12 scan found. Item 8 — Deep Dive derived
  totals and Cash Back Visa fit — was the last of them and closed `B73` on
  2026-08-14. What each move settled is `B73`'s; this file does not keep a
  second running count. AF-CAL-01's entry gate is now met. This item does not
  start `B74`.

### AF-CAL-01 · Give the schedule one owner

- **Outcome** — the on-page calendar and the exported `.ics` stop deriving from
  different sources, or each is shown to answer a genuinely different question.
- **Incumbent** — `Forecast.expandEvents` owns the schedule;
  `scripts/calendar-ics.js` derives its own. `DERIVE` or `REPLACE` — the item
  decides which and records it.
- **Tier** — M3. **Backlog** — `B74`.
- **Entry gate** — AF-AUTH-02, so the schedule authority is settled first.
- **Acceptance** — a due date or amount corrected in one place cannot sit stale in
  the other, and a test demonstrates that; or the document records why the two
  legitimately differ, and what stops them drifting.
- **State** — **complete.** Merged as PR #37 on 2026-08-14. Owner chose
  Option A: ICS cash payments `DERIVE` from `Forecast.expandEvents`; standing
  reminders stay independent and tagged as non-cash. `data.json` `upcoming` is
  deleted as a schedule authority. Acceptance is proved by
  `test-schedule-authority.js`. HELOC 21st vs month-end cash treatment remains
  Q19 and is not closed by this item; the 21st stays on the calendar as a
  reminder-only look-point, not a cash payment. Do not reopen the closed
  schedule-authority list in the post-B74 disposition.

### AF-QSTAT-01 · One authority for question status

- **Outcome** — `docs/01_OPEN_QUESTIONS.md` decides OPEN / ANSWERED; household-
  facing surfaces cannot independently contradict it. Demonstrated live split:
  Q2 and Q5.
- **Incumbent** — `docs/01_OPEN_QUESTIONS.md`. `EVOLVE` the publication copy
  (`data.json` `questions` and any docs that restate status) so it derives or
  is guarded, not a second status authority. `REPLACE` the independent Deep
  Dive status bit.
- **Tier** — M2, and it **may trigger the blocking review** if the PR changes
  `data.json` or a page the household reads. **Backlog** — `B87`.
- **Entry gate** — AF-CAL-01 complete.
- **Acceptance** — a test fails when a household-facing surface claims a
  question is answered while `01_OPEN_QUESTIONS.md` still has it OPEN, or the
  reverse; Q2 and Q5 are the proving cases. The PR does not invent household
  answers.
- **Non-goals** — answering Q2/Q5 as a household fact; a question registry
  product; moving financial figures.
- **State** — **complete.** `docs/01_OPEN_QUESTIONS.md` remains the sole
  status authority. `data.json` `questions` no longer encodes answered via
  `tier === 0` or `ANSWERED —` records. Deep Dive renders priority tiers only.
  Q2 and Q5 stay OPEN. Acceptance is proved by `test-question-status.js`.

### AF-LINE-01 · Tests must not depend on checkout line endings

- **Outcome** — source-scraping tests express code/architecture invariants
  without spuriously failing on CRLF.
- **Incumbent** — the `npm test` suites. `EVOLVE`.
- **Tier** — M1. **Backlog** — `B88`.
- **Entry gate** — after `AF-QSTAT-01`, because this is cheap and isolated,
  not because question status depends on it.
- **Acceptance** — the function-boundary extractors that currently match LF
  and miss CRLF no longer fail a CRLF checkout; Linux CI remains green. Prefer
  newline-tolerant regexes and/or `.gitattributes` `eol=lf`. Do not weaken the
  invariants the regexes were protecting.
- **Non-goals** — Windows product support as a feature; changing financial
  tests' numerical meaning.
- **State** — **complete.** Source-inspection tests normalize checkout newlines
  at the test input boundary (`test-source-text.js`). LF and CRLF of the same
  logical source extract the same blocks; the old LF-only `\n}\n` boundary still
  misses CRLF; malformed source still fails. Proved by `test-line-endings.js`.
  No `.gitattributes`; product bytes and financial answers are unchanged.

### AF-PUB-01 · Stop storing derived publication totals

- **Outcome** — where Atlas already has canonical inputs and deterministic
  derivation, the published result is not maintained independently. Known
  copies: headline total debt, net-worth totals, income total, duplicated
  mortgage publication/model values.
- **Incumbent** — `data.json` `debts` / `assets` / `income` / `plan` as
  inputs; the stored totals `DERIVE` or are deleted. `EVOLVE` in place.
  **Do not redesign `data.json`.**
- **Tier** — M3 if a household-facing figure is now derived rather than
  stored. **Backlog** — `B89`.
- **Entry gate** — after `AF-LINE-01`.
- **Acceptance** — each named copy is either derived from its canonical
  parent at render/test time, or deleted because a consumer already computes
  it; a mutation of the parent moves the published total; no schema redesign.
- **Non-goals** — splitting forensic/archive material out of `data.json`; a
  generic DTO layer.
- **State** — **complete.** `Forecast.publicationTotals` derives Deep Dive
  headline total debt, annual interest and credit left, Records net-worth
  lines, the income footer, the commitments total, the lacrosse verified
  total, and the HELOC chart limit from the canonical rows. `data.json`
  `headline`, `netWorth` numeric totals, `incomeTotal`, `helocLimit`,
  `commitments.total`, `lacrosse.verified`, and the mortgage block's
  balance / rate / bi-weekly payment are deleted. Credit left moves from
  the stale stored $1,415.95 to `Forecast.utilisation`'s $1,415.98, which
  the Plan tile, upcoming note and positions.csv already published.
  Proved by `test-publication-totals.js`.

### AF-CLASS-01 · Guard overlapping spending classifications

- **Outcome** — the same household spending category cannot silently tell
  contradictory essential/discretionary stories. Genuinely distinct semantics
  (`business`, `reserve`) stay distinct.
- **Incumbent** — `plan.budget.categories[].class` for the forward cap;
  `docs/merchant-library.csv` `type` → `periods.json` for historical mix.
  `EVOLVE` with a guard, not a new classifier.
- **Tier** — M2. **Backlog** — `B90`.
- **Entry gate** — after `AF-PUB-01`.
- **Acceptance** — overlapping category labels cannot disagree on
  essential/discretionary without a failing test; `business` and `reserve`
  are named exceptions, not silently coerced.
- **Non-goals** — a unified classification ontology; recategorising history.
- **State** — **complete.** `test-classification.js` joins
  `plan.budget.categories[].class` to merchant-library / `periods.json` types
  on the existing `from[]` list. Comparable pairs must agree; `business`,
  `reserve`, and `unknown` stay named non-comparable semantics. School & clubs
  is owner-confirmed essential on both sides (Q24 ANSWERED 2026-08-16), not a
  live comparable disagreement. Health source rows remain mixed essential/discretionary (medical
  vs personal care); that mix is a closed source-semantic ambiguity, not an
  owner guess. `Forecast.rollupSpending` publishes the mix as `unknown` so
  Deep Dive cannot consume it as a clean essential/discretionary class from
  first-event order. Published Plan cash figures and historical discretionary
  dollar totals are unchanged; Health leaves the historical essential class
  because that class was the collapsed first-event story. Phase 1 product
  exit has no blocking product gap. `AF-TEST-01` / `B92`, `AF-DEDUP-01` /
  `B93`, `AF-RECON-01` / `B91`, `AF-PLAN-01` / `B94`, and
  `AF-PLAN-02` / `B96` are complete.

### Phase 1 product exit — useful before infrastructure

Before Phase 2 starts, the current authorities must add up to a household-facing
operating picture rather than merely a collection of correct components. This is
a sequencing checkpoint, not a new engine and not a licence to duplicate any
financial answer.

The existing product must be able to show, from the same authorities:

- **one 13-week story** — current cash position, expected income, obligations,
  known commitments, the lowest projected point and the major pressure dates;
- **one week-by-week operating budget** — the `Forecast.recommend` safe-to-spend
  figure, what each week has to absorb, and whether a week is below the buffer;
- **one calendar/look-ahead** — next due, Amanda income dependency where relevant,
  paydays and known large events all reconciled to the schedule authority;
- **the consequence of a known large commitment or owner-supplied planned
  purchase** — amount and date enter the existing plan/commitment path, and Atlas
  can show whether cash covers it, what has to be saved or moved, and what debt
  is created if borrowing is required; and
- **honest confidence** — historical unknowns remain included in total spending
  and are not allowed to masquerade as zero merely because their category is
  unresolved.

If the existing authorities cannot answer one of those without page-local maths
or a second planner, record the smallest missing product capability in
`BACKLOG.md` and finish it before `AF-TEST-01`. Do not solve the gap by standing
up another forecast, another calendar or another budget. Do not skip the
post-B74 cleanup (`B87`–`B90`) or the post-B90 prerequisites (`B92`, `B93`) to
start snapshots or reconciliation.

**Assessed after `AF-CLASS-01` / `B90` (2026-08-14).** No blocking *product*
gap. The incumbent Plan schedule, weekly cap, calendar, commitment path, and
unknown-spend inclusion already answer those five questions from one
authority chain. Remaining gaps are evidence freshness (`B91`) and owner
policy such as Q24, not missing product machinery. The Aug. 14 reviews and
payday test then showed the prerequisites: refresh-safe tests (`B92`) and
derive/delete of proven duplicate live facts (`B93`). Both are complete.
`B80`, the live Lunch Money observation test, and `B95` are also complete.
Critical path through `AF-PLAN-02` / `B96` is complete: the payday
answer is composed from the `B91` opening and the `B94` master engine.
The 2026-08-16
master-forecast contract is destination, not a retroactive Phase 1 gap.

### AF-TEST-01 · Make ordinary evidence refresh cheap

- **Outcome** — behaviour tests no longer fail solely because a legitimate
  canonical household value changed. A refresh of Chequing A, MBNA, Fusion
  paid status, or payroll does not require rewriting unrelated suites.
- **Incumbent** — the `npm test` suites. `EVOLVE`. Live `data.json` remains
  the canonical household state; tests stop treating its current cents as
  the only fixture.
- **Tier** — M2. **Backlog** — `B92`.
- **Entry gate** — `AF-CLASS-01` (`B90`) complete.
- **Acceptance** — changing a live cash, card, commitment-paid, or payroll
  figure in a throwaway clone does not fail suites that are not asserting
  that figure; invariants that should fail on a real contradiction still
  fail. Prefer fixtures or derived expectations over copied live cents.
- **Non-goals** — reconciliation; changing household figures; weakening
  financial invariants.
- **State** — **complete.**

### AF-DEDUP-01 · Derive or delete proven duplicate live facts

- **Outcome** — live facts that already have two canonical homes are
  derived or deleted so `B91` is not asked to keep them synchronised.
  The four named copies were re-verified on current `main` and then
  derived or deleted.
- **Incumbent** — `data.json` live rows. `EVOLVE` in place: derive or
  delete the loser. `Forecast` stays the engine. Do not add a sync job.
- **Tier** — M3 if a household-facing figure is now derived rather than
  stored. **Backlog** — `B93`.
- **Entry gate** — after `AF-TEST-01`, so the deletions are cheap to prove.
- **Acceptance** — each named copy is derived, deleted, or shown not to
  be a duplicate on current `main`; a mutation of the parent moves the
  derived copy; no permanent dual-write; `docs/positions.csv` is not
  promoted into a universal fact database.
- **Non-goals** — leaf-level provenance; a fact schema; reconciliation
  itself; changing the Aug. 9 balances to Aug. 14 values.
- **State** — **complete.** Cash balances live on `plan.startingCash`
  account rows; matching `assets[]` rows keep label/order and a `cash` id.
  Overdraft `used` and funding-option availability are `max(0, −chequing-b)`
  and `max(0, limit − used)` from `revolvingExtra.limit`. `debts[].balance`
  is the posted opening. Recurring historical `perMonth` is
  `round(total / window)`; the insurance one-off keeps `perMonth: null`.
  Proved by `test-dedup-facts.js`. Published Plan figures unchanged 75/75
  vs starting main.

### AF-RECON-01 · Evidence refresh / reconciliation loop

The next major product milestone after the two prerequisites above. Not a
new layer: connect the observation records and canonical state that already
exist.

- **Outcome** — a small, repeatable, **non-writing** reconciliation report
  compares extracted evidence to current Atlas canonical values (value,
  date, difference, MATCH / STALE / CHANGE / CONFLICT / MISSING).
  Owner-approved changes then update canonical household state. First
  version covers a closed set, not every field in `data.json`. A live
  opening observation carries cutover / as-of semantics so events already
  inside that observation are not replayed by `Forecast.expandEvents`.
  After writing a coherent current-state opening from the **freshest
  complete evidence**, existing Forecast must be able to produce the
  household payday plan without ChatGPT constructing a second budgeting
  model. The Aug. 14 payday corpus remains the distinction checklist, not
  the only acceptable cutover. Do not assert $600/week as the expected
  output.
- **Incumbent** — existing `scripts/` extractors, `derived/`, `data.json`,
  `public/periods.json`, and existing observation/position records.
  `NEW` report, `CONSUME` extractors, `EVOLVE` the handoff into
  `data.json`. Does **not** replace `Forecast`, the Evidence-Use Register,
  or `01_OPEN_QUESTIONS.md`. Does not make `docs/positions.csv` a universal
  fact database.
- **Tier** — M3. **Backlog** — `B91`.
- **Entry gate** — `AF-TEST-01` (`B92`) and `AF-DEDUP-01` (`B93`), plus
  Phase 1 product exit and `AF-CLASS-01` (`B90`), all complete.
- **Acceptance** — **met 2026-08-16.** The published opening is
  2026-08-16 from the Lunch Money observation plus same-day
  Triangle/MBNA screenshots. The Aug. 14 payday corpus in
  `docs/source_intake/PAYDAY_ACCEPTANCE_2026-08-14.md` remains the
  distinction checklist: same-day income is not double-counted; schedule
  ≠ posted; paid commitments no longer reserve cash; Hydro schedules
  dated amounts due rather than the account total; household obligation
  stays distinct from paying account; card posted/pending/limit/available
  are distinct where evidence exists; Amanda's mixed-purpose balance is
  not auto-spendable; Amanda salary, coaching, and transfers do not share
  one income authority; Q19 HELOC cash impact stays unresolved rather
  than claimed zero; near-boundary obligations remain visible from
  existing Forecast; the report does not write canonical state by itself.
  $600/week is not encoded as policy.
- **Non-goals** — a database, second store, generic fact schema, workflow
  engine, event sourcing, classification registry, provenance graph,
  staging platform, generated `data.json`, `plan.proposals[]`, leaf-level
  source objects, a second payday or budgeting engine, Google Sheet or
  ChatGPT as authority, resolving Q19, implementing operational margin.
- **Prompt** — *After B92 and B93, connect existing observation records to
  one canonical pointer with a non-writing reconciliation report the suite
  can fail. Use the Aug. 14 payday corpus as the distinction checklist, and
  take the cutover opening from the freshest complete evidence. Owner-
  approved edits still land in `data.json`. Do not generate `data.json`.
  Record what review ceremony the run actually needed — that is evidence
  for the open governance question, not a new gate.*
- **First slice — not completion.** The closed cash/debt compare
  (`scripts/reconcile.js` + `docs/reconciliation/balance-map.json`) and the
  `representedEvents` cutover on `Forecast.expandEvents` are the foundation.
  **D3 slice — not completion.** A commitment may carry `settledOn`.
  Forecast treats it as already satisfied only when that date is on or
  before the simulation start, then emits no future cash event. Settlement
  observations compare that field and do not write `data.json`. Live Fusion
  camp / tryouts now carry `settledOn: "2026-08-14"`. The three stale
  $500 Fusion season instalments were later removed (Q23 ANSWERED); the
  upcoming season is the `B95` `fusion-season` estimate.
  **D4+D5 slice — not completion.** Dated `plan.bills` may carry
  `payingAccount`. Household obligation stays distinct from the paying
  account and from joint-cash deduction. Hydro observations compare the
  Aug. 14 account balance as informational and the dated dues as
  scheduled requirements; they do not write `data.json`. Live Hydro now
  includes the 1 September $237.45 dated due as an Amanda-paid household
  obligation. The old arrears are settled (Q17 ANSWERED).
  **D2 slice — not completion.** Amanda-income observations distinguish
  Tennis BC salary, coaching/business inflows, obligations, household
  transfers, and household-available remainder. Owner-confirmed
  2026-08-22: the two fixed Tennis BC salary deposits are Forecast
  household income. Owner-clarified 2026-08-31: they first land in
  TENNIS INCOME; household-visible posting proof is the later BILLS
  transfer. Later transfers of those same dollars are not a second
  income line. Coaching surplus is not
  forecast. Unknown business obligations fail closed. The raw TENNIS
  INCOME balance remains non-spendable coaching/business remainder.
  **D8 slice — not completion.** Card-state observations distinguish
  posted balance, pending, limit, available credit, and confirmed
  payment. Unknown pending is not $0. Limit and available credit are
  never household cash. A scheduled payment does not reduce current
  exposure. Live card canonical state is unchanged.
  **Pending-transaction slice — not completion.** Mapped Lunch Money
  pending card transactions become pending observations. A 90-day
  presumed-settled treatment applies only to pending bill/payment
  effects for current forecasting. Same `providerTransactionId`
  pending→posted is collapsed in fixtures. Live `data.json` is not
  written. The Bell Mobility transaction remains pending and is not
  a completed B78 proof.
  **D7 slice — not completion.** Posting observations distinguish a
  scheduled occurrence from a posted one and compare that fact to
  `plan.opening.representedEvents`. Forecast remains the schedule
  authority. Unknown posting is not posted and is not unposted. Live
  `plan.opening` is unchanged.
  **D11 slice — not completion.** Payday output exposes named
  joint-cash obligations already in the Forecast event stream on the
  next payday and the following calendar day, before surplus-use
  guidance. Forecast arithmetic is unchanged. Live household facts are
  unchanged. Q19 remains a household question and must fail closed. B20
  history, a universal STALE threshold, and $600/week are not B91
  closers.
  **Current-state cutover — complete 2026-08-16.** The published Forecast
  opening is 2026-08-16. Fusion camp and tryouts remain
  `settledOn: "2026-08-14"`. The 1 September Hydro dated due remains an
  Amanda-paid household obligation. The 14 August payday cluster is
  inside the opening and is not replayed. Rogers posting, HOME
  BUDGET.xlsx, Q19, unknown card pending as $0, and $600/week are not
  promoted. Date relation is reported without a universal STALE
  threshold.

### AF-PLAN-01 · One master forecast; ranges are views

Owner instruction 2026-08-16 established the product contract in
`ARCHITECTURE.md`. The engine work is **done**. `B95` has
already given the known major future costs one Plan home.

- **Outcome** — Forecast, in place, is the one master household forecast with
  a knowledge horizon of at least twelve months. Week, payday, month, 13
  weeks, 6 months, 1 year, and a custom date range are views of that same
  projection. Changing the visible range does not change what the plan
  knows. Known major costs outside the visible span still constrain today's
  `Forecast.recommend` safe-to-spend. Forecast sequences funding among
  future commitments by timing, certainty, owner-stated priority, and
  flexibility, and reallocates capacity a commitment releases rather than
  turning it automatically into safe-to-spend. Planned debt may be part of
  the path when it is the better household plan, including to preserve cash
  for higher-priority needs, and is forecast in advance with consequences
  and a repayment path on the existing cash-and-debt walk. Debt is
  owner-constrained and never automatic. Named major future plans publish
  ON TRACK / AT RISK / FUNDING GAP from Forecast. Those three verdicts
  apply to major future plans, not to individual transactions or budget
  categories. Ordinary spending matters through its aggregate effect on
  the household's ability to fund those plans.
- **Incumbent** — `Forecast` (`expandEvents`, `simulate`, `recommend`,
  `projectDebts`) and `data.json` `plan`. `EVOLVE`. Does **not** replace
  Forecast, add a goals engine, add a payday engine, or invent a generic
  planning schema. `B95` already absorbed the known costs onto
  `plan.commitments`; this item does not re-home them.
- **Tier** — **M3** when the engine work starts. The 2026-08-16 contract
  pull request is documentation only (M1 on figures; still triggers the
  blocking review because it records product direction).
- **Backlog** — `B94`.
- **Entry gate** — prefer `AF-RECON-01` / `B91` far enough along that the
  longer horizon is not built on a stale opening. Do not wait on `B20` /
  `B21`, provider-completeness, or a historical Aug. 14 opening once a
  later complete cutover exists. Do not start this item in order to mark
  `B91` done. `B21` is now the Lunch Money refresh proof, not a PDF month.
- **Acceptance** — one Forecast projection; named ranges are views; a
  hidden later commitment still reduces today's cap; funding sequence,
  reallocation of released capacity, and planned-debt repayment are
  Forecast results; major-plan verdicts come from Forecast; pages render.
  Proof is independent of the function under change. No second planner.
  End-to-end payday proof is `AF-PLAN-02` / `B96`, not this item.
- **Non-goals** — a second planner; a generic schema; a goals product; a
  retirement engine; changing live household facts in a planning PR;
  finishing `B91`; opening the store or connectivity gates; applying
  ON TRACK / AT RISK / FUNDING GAP to ordinary transactions or budget
  categories.
- **State** — **engine earned 2026-08-16; contract repaired 2026-08-17.**
  `Forecast.recommend` searches `Forecast.knowledgeHorizon` and reserves
  protected principal jointly. Named ranges are views.
  `Forecast.fundingSequence` is presentation order.
  `Forecast.majorPlans` owns ON TRACK / AT RISK / FUNDING GAP (base
  infeasibility is a gap; AT RISK is a protected uncertainty case).
  `Forecast.plannedDebt` is opt-in, purpose-specific, and invents no
  permission. An authorized amount may finance a named purpose when that
  is the better plan, not only when cash is short; a feasible walk may
  not cross a facility limit in the interim. `B95` absorption already
  done. End-to-end payday proof is `B96` / `AF-PLAN-02` and is complete.

### AF-PLAN-02 · Prove the payday question end-to-end

After `AF-PLAN-01` / `B94`. This is a distinct critical-path step, not
part of the engine item.

- **Outcome** — a household payday answer is produced from the closed
  loop: fresh evidence → canonical state → Forecast → household answer.
- **Incumbent** — `B91` canonical state and `B94` Forecast. `CONSUME`.
  Does **not** add a payday engine, a second forecast, or encode
  `$600/week` as policy.
- **Tier** — **M3**. Independent proof of the path a household actually
  reads. **Backlog** — `B96`.
- **Entry gate** — `AF-RECON-01` / `B91` far enough that the opening is
  current canonical state, and `AF-PLAN-01` / `B94` far enough that
  Forecast is the master projection.
- **Acceptance** — the payday question is answered from that chain;
  proof is independent of the function under change; no second planner.
- **Non-goals** — implementing the master-forecast engine (`B94`);
  finishing `B91`; a second payday engine; encoding `$600/week`.
- **State** — **proved 2026-08-16.** The Plan page composes the household
  payday answer from incumbent Forecast results. No second payday engine.
  Independent proof is `test-b96-payday.js` on the 2026-08-16 opening.

---

## Phase 2 — cadence and trend · to T2

Spending, interest and fees already have history through `public/periods.json`.
**Account balances now have dated openings** through `snapshots/`. T2 is met
by the independently reconciled 2026-08-09 / 2026-08-16 pair. **This phase
no longer starts with snapshots.** Post-B74, `AF-RECON-01` was the milestone
after Phase 1; history is a by-product of successful refresh, not the next
item after the product exit. `AF-INTAKE-01` / `B21` is the real-world
proof of the **normal Lunch Money refresh path**, not a second PDF month
and not a T2 requirement. It is **DONE 2026-08-17**.

### AF-HIST-01 · Balance snapshots and trend

- **Outcome** — one file per reading, same shape as `data.json`, with the site
  drawing trend lines across them, so "is the HELOC actually falling" is
  answerable from the repository. Prefer producing the snapshot from a
  successful refresh rather than a separate capture ritual.
- **Incumbent** — `data.json` for current figures; `public/periods.json` for the
  spending series, which this does **not** duplicate. `NEW`, consumer named: the
  Plan and Deep Dive pages.
- **Tier** — M3. **Backlog** — `B20`.
- **Entry gate** — **`AF-RECON-01` complete**, plus T1 and the Phase 1 product
  exit. Do not start this item because an earlier revision of this file put it
  first in Phase 2.
- **Acceptance** — **each snapshot's identity and contents reconcile
  independently** against the contemporaneous `data.json`, the `positions.csv`
  row, or institution evidence — right account, right date, right balance. That is
  the acceptance that matters: a check that two files render a trend and that
  re-running adds no duplicate proves storage and rendering, not that the history
  the household reads is true. Also: a snapshot is written without hand-editing;
  re-running produces no duplicate; and the spending series stays
  `public/periods.json`'s and is not re-derived here.
- **Prompt** — *Implement `snapshots/<YYYY-MM-DD>.json` per `B20` as a by-product
  of the refresh loop. Files, not a store — `ARCHITECTURE.md` says git gives
  history, diffs and versioning free, and the store gate is closed. Do not touch
  the spending series.*
- **State** — **proved 2026-08-17.** Two dated openings, independently
  reconciled. Mixed-date rows omitted. Re-run is a no-op. Plan page prints
  display deltas. T2 met on the stored HELOC pair. `B21` and `B78` are done.

### AF-INTAKE-01 · Prove the normal Lunch Money refresh path

- **Outcome** — a later/fresh Lunch Money observation is run through the
  existing path: live/read-only Lunch Money observation → existing
  reconciliation → clear proposed canonical changes / conflicts / missing
  facts → Forecast-ready refresh boundary. The run records what Lunch Money
  supplied automatically, what owner-maintained Lunch Money accounts
  depended on manual freshness, what could map automatically, what required
  human reconciliation, what provider semantics remain ambiguous, and what
  Atlas cannot get from Lunch Money and still needs owner or institution
  evidence for. A stale manual Lunch Money account does not block unrelated
  automatically refreshed accounts.
- **Incumbent** — `scripts/provider-observe.js`, `scripts/reconcile.js`, and
  the flow in `ARCHITECTURE.md`. `CONSUME`. Does **not** replace Forecast,
  write `data.json` automatically, or invent a second reconciler.
- **Tier** — M2. **Backlog** — `B21`.
- **Entry gate** — `AF-RECON-01` (done) and the live read observation seam
  (done). Snapshots (`AF-HIST-01`) should come out of a later successful
  canonical refresh when they can, not block this proof. Do **not** wait
  for a second month of routine statement files.
- **Acceptance** — the run is reproducible from the documented steps alone;
  every human reconciliation step is written down; freshness metadata for
  owner-maintained Lunch Money accounts is preserved rather than invented;
  no automatic canonical write is claimed. File-statement capture is not
  required to close this item.
- **Prompt** — *Run a later/fresh live Lunch Money observation through the
  existing observe → reconcile path. Change nothing to make it write
  canonical state. Record what mapped, what needed a human, which accounts
  depended on owner-maintained Lunch Money freshness, and what Lunch Money
  cannot supply. That record is the input to AF-INGEST-01. Do not require a
  second month of PDFs.*
- **State** — **DONE 2026-08-17.** Owner-run later live observation
  `2026-08-17T23:38:15.373Z` through incumbent observe → reconcile.
  Sanitized proof:
  [`docs/connectivity/LUNCH_MONEY_REFRESH_PROOF_2026-08-17.md`](connectivity/LUNCH_MONEY_REFRESH_PROOF_2026-08-17.md).
  10 mapped, 2 unmapped by policy. MATCH 11 / CHANGE 8 / no CONFLICT /
  MISSING / STALE. No canonical write. Fresh $10 Chequing B unused.
  Triangle same-day discrepancy unresolved. Historical payroll
  posting-candidate CHANGE rows recorded as noise. Automatic-versus-
  manual endpoint origin not preserved and not invented. No real
  pending→posted case. T4 / `B81` was still closed at B21 close.

---

## Phase 3 — an ingestion foundation · to T3

**Files still exist as fallback.** This phase proves identity and
idempotency on the **normal Lunch Money observation/import path**, using
existing provider account IDs / transaction IDs and the existing
reconciliation architecture. No new identity system. No store. No automatic
canonical writer.

### AF-INGEST-01 · Idempotent Lunch Money import with stable identity

- **Outcome** — **DONE 2026-08-17.** The normal Lunch Money
  observation/import path is identity-stable and idempotent. Demonstrated
  on **real household Lunch Money data**: leftover 2026-08-16 observation
  replayed twice (identical fingerprint, MATCH 12 / CHANGE 0);
  display-name change kept the same target; a Chequing B correction
  updated `cash:chequing-b` in place; historical payroll did not backfill
  `representedEvents`; unmapped accounts failed closed; credit was not
  cash. No real pending→posted case; recorded, not invented.
- **Incumbent** — `scripts/provider-observe.js`, `scripts/reconcile.js`, and
  existing Lunch Money provider IDs. `EVOLVE`. File-statement re-import
  remains useful later as fallback/backfill, not as this item's proof.
- **Tier** — M3. **Backlog** — `B78`.
- **Entry gate** — **T2** (met), plus AF-INTAKE-01's 2026-08-17 proof
  record. Automatic-versus-manual endpoint origin was **not** preserved
  and was not fabricated.
- **Acceptance** — proved. See
  [`docs/connectivity/LUNCH_MONEY_IDENTITY_PROOF_B78.md`](connectivity/LUNCH_MONEY_IDENTITY_PROOF_B78.md).
  A new live GET was not available in the builder shell; the leftover
  owner-run observation is the real-data evidence. Do not reopen to
  apply the unused $10 Chequing B change or to invent pending→posted.
- **Prompt** — *closed.*

### AF-STORE-01 · The store question, answered by evidence

- **Outcome** — **DONE 2026-08-18.** The file foundation has **not**
  demonstrably failed. Stay with files. Store gate stays closed. Written
  answer: [`docs/STORE_QUESTION_B79.md`](STORE_QUESTION_B79.md).
- **Incumbent** — `data.json`, generated `public/periods.json`,
  observation/reconciliation files, dated `snapshots/`, and git as the
  history. `CONSUME`.
- **Tier** — **M4** — `ARCHITECTURE.md` says passing the gate is an owner
  decision, recorded. The gate was **not** met, so no owner pass is
  requested. **Backlog** — `B79`.
- **Entry gate** — AF-INGEST-01 complete.
- **Acceptance** — the answer cites what failed on real data: **nothing
  required failed in a way that needs a store.** B78 / T3 identity and
  idempotency held. "Relational modelling would be tidier" and "a later
  capability assumes it" remain insufficient.
- **Prompt** — *closed.*

---

## Phase 4 — trusted canonical refresh · gated at T4

`ARCHITECTURE.md` still owns the connectivity gate. **Live read-only Lunch
Money observation already exists and has already been exercised.** Do not
write as though Atlas has never touched live Lunch Money. T4 passed and
`B81` / `AF-LIVE-02` is the earned trusted canonical-refresh capability:
preview / approve / bounded writes, the published 2026-08-19 opening, and
the read-only live overlay. Automatic or unrestricted production writes
from that live feed remain **owner-reserved**, not an unfinished B81
implementation slice. The 2026-08-17 owner decision establishes product
direction (Lunch Money is the normal feed). It does **not** authorize bank
credentials, money movement, autonomous institution changes, silent
production writes, bypassing reconciliation, or treating unknown/stale
values as current.

The owner recorded condition 1 and authorised the B80 evaluation plus the
observe seam. That evaluation and the live Lunch Money **read** test are
**done**. Remaining provider-completeness work is not a critical-path gate.
**T4 passed 2026-08-17.** `B81` is **done** as the earned preview/approve
writer, the 2026-08-19 canonical opening, and the read-only overlay.
Unattended production writes and a newer live substitute
opening remain reserved. A production GET-only token is authorized 2026-08-23.
The 2026-09-04 `category_id` grants live in `ARCHITECTURE.md` and the
production pass: the exhausted one-transaction write, and the later
reusable Other Spending class.

### AF-LIVE-01 · Evaluate providers, point nothing live

- **Outcome** — a written evaluation of what actually serves these institutions
  in Canada, verified when the work starts, and what each provider's failure modes
  cost. First personal-API candidate recorded: Lunch Money.
- **Tier** — M4. **Backlog** — `B80`. **Entry gate** — owner instruction 2026-08-16
  (manual freshness bottleneck). T3 is not required to *evaluate*.
- **Acceptance** — evaluation written; no live credential in the repo; no
  `data.json` write; observe CLI is fixture-first.
- **State** — **complete 2026-08-16.** Written evaluation is
  `docs/connectivity/PROVIDER_COVERAGE.md`. The owner completed a live
  Lunch Money GET the same day; that pull stays out of git. Mapped
  pending rows already feed B91 observations. Do not schedule this item
  or the live observation test as a future milestone. Completeness of
  every household product field remains UNKNOWN where the coverage
  matrix says so, and is not a critical-path gate. The live GET did not
  close `B81`; the later T4 pass did, for the preview/approve writer only.
- **Prompt** — *Evaluate current Canadian availability and provider semantics per
  `ARCHITECTURE.md`'s conditions 2 and 4. Obtain no credential. Do not open T4.*

### AF-LIVE-02 · Trusted canonical refresh from the live feed

- **Outcome** — supported Lunch Money observations may update canonical
  Atlas state through the earned refresh mechanism, after the full remaining
  gate. This is **not** the first live GET. That GET already exists.
- **Tier** — M4. **Backlog** — `B81`. **Entry gate** — remaining
  connectivity conditions including identity/idempotency (T3), security
  review, and **owner pass**. Live read observation is already an incumbent.
  **Entry recorded 2026-08-17.**
- **Acceptance** — writes are through `scripts/canonical-refresh.js`;
  reconciliation is not bypassed; unknown/stale values are not treated as
  current; no institution login credential, ever, under
  `ARCHITECTURE.md`'s absolute; any provider token handled under the secret
  boundary's configured-secret rule; no silent or unattended production
  writes.
- **State** — **complete 2026-08-20 as the earned capability. Production
  activation remains reserved.**
  Preview / approve / bounded posted-field write is earned. Candidate-date
  pending writes are earned through a distinct `cutoverApprovalId`. A clean
  `--cutover-as-of` preflight can propose one atomic opening through a
  distinct `openingApprovalId` (`atlas-opening-cutover-approval/v1`).
  `previewId` and `cutoverApprovalId` cannot authorize that opening. MATCH
  is not freshness. An approved opening write is one coherent transition:
  canonical `data.json`, same-date Household evidence in `docs/positions.csv`
  constructed from the approved observation, derived computed rows, and
  `snapshots/<date>.json` using incumbent snapshot semantics. Canonical
  files are not permanently mutated unless that whole transition is
  constructible. If that opening already exists in `data.json` and the
  same-date positions/snapshot are missing, `--recover-opening-artifacts`
  reconstructs only those two surfaces from a complete MATCH packet after
  exact `--approve-recovery`; it never writes `data.json` and never infers
  the missing rows from the surviving file alone. Live `data.json` on
  `main` is the 2026-08-19 opening. Today's Forecast may overlay current
  posted/pending from a Lunch Money observation in memory
  (`scripts/live-plan.js`) without rewriting that opening or snapshots.
  The in-memory clone starts Forecast on the observation's household
  financial date only when the live packet is freshness-qualified for
  that date; MATCH is not freshness, and an incomplete or stale packet
  fails closed. A complete trusted current-cash observation remains the
  Forecast opening when a same-day inbound is unproven or ambiguous; that
  inbound is not counted until proven and is not labelled represented.
  Incomplete current cash still fails closed. Same-day unposted joint-cash bills
  stay still due. Unrepresented joint-cash outflows between the dated opening
  and the live as-of stay reserved through `plan.opening.priorAsOf`.
  Unattended production writes and a newer live substitute
  opening remain reserved. A production GET-only token is authorized 2026-08-23.
  The 2026-09-04 `category_id` grants live in `ARCHITECTURE.md` and the
  production pass: the exhausted one-transaction write, and the later
  reusable Other Spending class.
  They do not keep this item unfinished.
- **Prompt** — *Do not apply the unused Chequing B $10, choose a Triangle
  same-day winner, invent a pending→posted case,
  schedule refresh, or invent a newer live substitute opening.*

---

## Governance follow-ups — not product truth

These concern **how work is governed**, not what the household's figures are.
They are sequenced separately, do not consume a phase slot, and do not gate any
product item. They are recorded here because leaving them only in a merge card
would lose them.

- **`B76` — the scope tripwire counts implementation only.** For a
  documentation-only change it therefore offers a reviewer no numeric prompt at
  all. Carried forward from a superseded pull request under a fresh identifier,
  and narrowed since: scope is now explicitly a reviewer judgement rather than a
  card field.
- **`B77` — the connector bypasses the pre-commit hook.** **DONE 2026-08-20.**
  Commits authored through the GitHub connector are made through the API, so no
  local hook runs on them. Closed by applying the incumbent
  `scripts/privacy-guard.js` engine from the trusted default branch to every PR
  head. Nothing in the repository was leaking; the gap was structural.
- **Cheaper review lane for routine refresh.** Recorded, not solved. Hard
  boundaries stay. `AF-RECON-01` / `B91` should produce evidence about whether
  a figures-only evidence update needs the same architecture review as an
  engine-authority change. Do not add a gate to get there.
- **Issue #57 remainder — autonomous delivery loop.** Governance, not product.
  The repair → handoff → GPT-5.6 follow-up → card-sync middle is live.
  Owner granted first REQUIRED GPT-5.6 reviews on 2026-08-16. Standing
  auto-merge of qualifying `auto-safe` PRs is granted but not operational
  until GitHub enforces the required checks on `main`. Next-node wakeup
  stays later on Issue #57. They do not reorder `B91`.

`BACKLOG.md` holds what each actually says, including the evidence and the
options — this file names them so the sequence does not lose them, and does not
keep a second copy of the reasoning. Neither changes a figure, and neither should
be scheduled as though it did.

---

## What this file deliberately does not schedule

- **A database, second canonical store, generic fact schema, workflow
  engine, event sourcing, classification registry, provenance graph,
  staging/approval platform, generated canonical state, leaf-level source
  object on every numeric field, `plan.proposals[]`, second extraction
  architecture, or second forecast / recurrence / payday / budgeting
  engine.** Post-B90: connect what exists. None of those is authorised by
  reaching `AF-RECON-01`. Permanent manual synchronisation between duplicate
  facts is the defect, not a fix. Google Sheet is not an authority.
- **Anything behind a closed gate.** A canonical store remains gated.
  Unattended production writes remain reserved after the T4 pass. Production
  GET-only observation is owner-authorized 2026-08-23. The 2026-09-04
  `category_id` grants live in `ARCHITECTURE.md`: the exhausted
  one-transaction write, and the later reusable Other Spending class.
  Live read-only observation already exists. `ARCHITECTURE.md` holds the remaining reservations.
- **A forensic cleanup of the historical ledger.** Old unknown transactions stay
  in total spending and may stay categorically unresolved unless they are large
  enough to materially change the plan. The forward ledger gets cleaner as fresh
  data arrives.
- **A standing 100% raw-source coverage campaign.** `raw/` remains the bedrock and
  must remain private and immutable, but source-coverage work is targeted when a
  material reconciliation gap appears; it is not a prerequisite to planning from
  the captured history.
- **Household questions.** `docs/01_OPEN_QUESTIONS.md` holds what only Dale or
  Amanda can answer. Several phases would move faster with answers, and none of
  them can be unblocked by an agent.
- **Owner actions.** Items marked *owner action* in `BACKLOG.md` are the owner's
  and are not sequenced here.
- **Silently reconciling one household member's stated preferences against
  another's.** Attributed interview evidence may inform a candidate scenario or a
  question, but a shared target needs the promotion/owner decision described in
  `ARCHITECTURE.md`; an agent does not decide whose statement wins.
- **Everything in `BACKLOG.md` this file has not named.** Those items stay
  eligible. This document is a sequence, not a gate on the backlog.

The named later capabilities, and the trigger that would reopen each, live in
the section that follows. That is how they stay findable without being
scheduled.

---

## Later capabilities — status and reopen trigger

This is not a second roadmap. It does not invent pull-request numbers, dates,
engines, schemas, APIs, or infrastructure. It is the memory of worthwhile
capabilities that [`ARCHITECTURE.md`](../ARCHITECTURE.md) names as destination,
that dated advisory notes preserve, or that the household has discussed, so they
cannot disappear merely because they are not in Phases 1–4.

Advisory origins are evidence, not adopted architecture. In particular
[`docs/advisory/COPILOT_ARCHITECTURE_GAME_PLAN_2026-08-13.md`](advisory/COPILOT_ARCHITECTURE_GAME_PLAN_2026-08-13.md)
is a dated design proposal and is **not** a sequence;
[`docs/advisory/EVIDENCE_ABSORPTION_RECOMMENDATION_2026-08-13.md`](advisory/EVIDENCE_ABSORPTION_RECOMMENDATION_2026-08-13.md)
explicitly declined to adopt that 13-PR copilot stack. This table does not
resurrect it.

| Status | Means |
|---|---|
| **ACTIVE** | Already sequenced in this file. The phase item is the work; do not invent a parallel programme. |
| **GATED** | `ARCHITECTURE.md` holds a capability gate. This file sequences toward it without opening it. Reopening is the owner passing that gate, not a plan line. |
| **PARKED** | Worthwhile and not forgotten. Wait for the named trigger. No date, no engine, no schema, no API. |

| Capability | Status | Home today | Reopen trigger |
|---|---|---|---|
| Evidence refresh / reconciliation | **ACTIVE** | `AF-RECON-01` / `B91`, after `B92` and `B93`. **Complete 2026-08-16.** Published opening is 2026-08-16. Aug. 14 corpus remains the distinction checklist. | Already sequenced. Do not replace with a store, schema, leaf-level provenance, or copilot absorption stack. |
| Refresh-safe tests | **ACTIVE** | `AF-TEST-01` / `B92`. **Complete.** | Already sequenced. Unpin behaviour tests from live household numbers. |
| Derive/delete duplicate live facts | **ACTIVE** | `AF-DEDUP-01` / `B93`. **Complete.** After `B92`, before `B91`. | Already sequenced. Derive or delete proven copies; do not add a sync layer. |
| Balance history / snapshots | **ACTIVE** | Phase 2 `AF-HIST-01` / `B20`. **Complete 2026-08-17.** Dated openings for 2026-08-09 and 2026-08-16. T2 met on the stored HELOC pair. | Already sequenced. Do not start `B21` in order to manufacture more history from PDFs. |
| One master forecast / longer operating horizon | **ACTIVE** | `AF-PLAN-01` / `B94`. **Complete 2026-08-16.** Live display remains 91-day `windowDays`; `Forecast.recommend` searches the ≥12-month knowledge horizon. `B95` already absorbed the known major costs. | Already sequenced. Evolve Forecast. Never a second recurrence, payday, goals, or forecast engine. |
| End-to-end payday proof | **ACTIVE** | `AF-PLAN-02` / `B96`, after `B94`. **Complete 2026-08-16.** Household payday answer is composed from incumbent Forecast results on the 2026-08-16 opening. | Already sequenced. Prove fresh evidence → canonical state → Forecast → household answer. Not a second payday engine. |
| Prove the normal Lunch Money refresh path | **ACTIVE** | Phase 2 `AF-INTAKE-01` / `B21`. **Complete 2026-08-17.** Later live observation through existing observe → reconcile. Proof: `docs/connectivity/LUNCH_MONEY_REFRESH_PROOF_2026-08-17.md`. | Already sequenced. Do not reopen to apply the unused $10 Chequing B change or to invent a pending→posted case. |
| Improved ingestion | **ACTIVE** | Phase 3 `AF-INGEST-01` / `B78`, to T3. **Complete 2026-08-17.** Identity-stable idempotent Lunch Money observation/import on real household data; existing provider IDs; no new identity system; no store. Proof: `docs/connectivity/LUNCH_MONEY_IDENTITY_PROOF_B78.md`. | Already sequenced. T3 met. `AF-STORE-01` / `B79` is complete; store gate stays closed. |
| Automated financial-data connectivity / trusted canonical refresh | **ACTIVE** (`B81`) | `ARCHITECTURE.md` connectivity gate. Live **read** observation (`AF-LIVE-01` / `B80` + GET) is **complete**. T4 **passed 2026-08-17**. `AF-LIVE-02` / `B81` is **complete** as the earned capability: posted, pending, opening-cutover, and same-date artifact-recovery writers in `scripts/canonical-refresh.js`; the published 2026-08-19 canonical opening; and the read-only in-memory live overlay (`scripts/live-plan.js`) consumed by `/data.json` and disclosed in the UI. An approved opening is one coherent canonical + positions + snapshot transition. Live `main` publishes the 2026-08-19 opening. The 2026-08-16 opening remains dated evidence. | Unattended production writes and a newer live substitute opening remain reserved. A production GET-only token is authorized 2026-08-23. The 2026-09-04 `category_id` grants live in `ARCHITECTURE.md` and the production pass: the exhausted one-transaction write, and the later reusable Other Spending class. Obtain no credential value in git. Do not apply the unused $10 or choose a Triangle winner. Do not treat those reservations as a missing B81 implementation slice. |
| Richer payroll / bonus / pension-contribution modelling | **PARKED** | The 91-day plan consumes estimated net pay. A statutory payroll engine (`EMP-006`) is excluded. Optional pension cash is already inside that net. No bonus cash event is on the live plan. | A named consumer that current net cannot serve — a window that includes a CPP/EI reset, or an owner-supplied bonus or pension cash event, or an owner-supplied horizon that needs statutory seasonality. Do not build a payroll engine in order to absorb a net `Forecast` already consumes. |
| Retirement planning | **PARKED** | `ARCHITECTURE.md` destination names pension and investments. Live published net worth excludes pensions. There is no `Forecast` retirement function. The advisory copilot "retirement engine" is not adopted. | An owner decision to include pensions in a published window, or to earn a retirement span on the one plan. Not a second planner. |
| Goals and sinking funds | **PARKED** | `ARCHITECTURE.md` destination names sinking funds. Known major future costs already live on `plan.commitments` (`B95`); property tax stays the existing reserve. That is one Plan home, not a goals engine and not a second planner. ON TRACK / AT RISK / FUNDING GAP is `Forecast.majorPlans` and applies only to those major plans. | Owner-promoted shared targets, or a product-exit gap that the existing plan/commitment path cannot answer. Do not stand up a goals engine beside `Forecast`. Do not create one ticket per purchase. |
| ChatGPT / copilot interface | **ACTIVE** (OAuth MCP connection slice) | `ARCHITECTURE.md` names ChatGPT as a conversational consumer, not an authority. Owner instruction 2026-08-24 earned `GET /assistant/current` via `scripts/assistant-packet.js` and dedicated Bearer `ATLAS_ASSISTANT_TOKEN`. Owner decision 2026-08-29 authorises only the OAuth infrastructure required for ChatGPT. The current slice exposes that same packet as `POST /assistant/mcp` / `get_atlas_current`, protected by an external OAuth authorization server and exact-resource/read-scope validation. Atlas remains only the resource server. Not a ChatGPT financial planner. Google Sheet tracks execution the same way. | Never a second financial answer, advisory copilot stack, Sheet authority, Atlas user platform, provider/canonical write, or financial action. Configure the external authorization server and install the connector as owner-operated deployment of this boundary, not as another financial capability. |
| Operational spend target vs mathematical maximum | **PARKED** | `Forecast.recommend` is the mathematical variable-spend maximum subject to the protected floor. The Aug. 14 payday session chose a lower operating amount. No household policy encodes $600/week. | Re-test after `B91` whether payday output should also show an owner-supplied operational target and remaining margin. Do not build that feature in order to record the question. |

A row here does not make an unlisted `BACKLOG.md` item ineligible. Canonical
store remains **GATED**. `AF-STORE-01` / `B79` answered the question:
the file foundation has not demonstrably failed
([`docs/STORE_QUESTION_B79.md`](STORE_QUESTION_B79.md)). Reopening still
requires a demonstrated failure on real data, then an owner decision —
not because a later capability would like a database.
