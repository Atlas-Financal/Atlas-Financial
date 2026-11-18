# Atlas Agent Context Architecture v1

How a coding agent should use this repository's instructions.

This file explains **authority vs skills vs learned lessons vs future
dreaming**. It is not product direction, not Forecast, not household truth,
not owner policy, not a second planner, and not a merge or review authority.

| For | Read |
|---|---|
| Product direction, financial authority, capability gates | [`ARCHITECTURE.md`](../ARCHITECTURE.md) |
| Who decides, who reviews, what a pull request carries | [`CLAUDE.md`](../CLAUDE.md) |
| Always-load read order | [`AGENTS.md`](../AGENTS.md) |
| Surface-neutral handoff | [`BUILDER_PORTABILITY.md`](BUILDER_PORTABILITY.md) |
| Task procedure (on demand) | [`skills/README.md`](skills/README.md) |
| Durable technical lessons (non-authoritative) | [`lessons/README.md`](lessons/README.md) |

If this file and an authority document disagree about a financial fact,
owner policy, Forecast behavior, security boundary, or merge gate, **that
authority document wins**. Fix this file.

This is a maintainability design, not a production-correctness hard gate.
`npm test` does not freeze skill counts, catalog wording, folder layout, or
disclaimer phrasing. Deleting an obsolete skill or consolidating lessons
must not fail an unrelated financial PR. Review of this layer is Git diff
plus the existing authority rules.

---

## The three layers

### 1. Authority — always loaded, rarely changed

Small durable rules that apply broadly.

Existing documents remain the owners. This architecture does **not** copy
them into a new master brief.

| Kind | Owner |
|---|---|
| Product direction, one-plan rule, secret boundary, capability gates | `ARCHITECTURE.md` |
| Operating, review, merge, owner-reserved stops | `CLAUDE.md` |
| Sequencing of planned capability work | `docs/ATLAS_FINANCIAL_BUILD_STRATEGY.md` |
| Standing financial facts | `docs/ACCOUNT_FACTS.md` |
| Published figures and owner policy as encoded today | `data.json` |
| What follows from `plan` | `Forecast` in `public/forecast.js` |
| Work and findings | `BACKLOG.md` |
| Questions only the household can answer | `docs/01_OPEN_QUESTIONS.md` |
| Index of settled owner decisions (pointers only) | `docs/OWNER_DECISIONS.md` |

**Always load first:** `AGENTS.md`, then the numbered read order it
defines. That order is already long. Do not add skills, lessons, or this
explainer to it.

### 2. Skills — load only when the task needs them

A skill answers: *when doing this kind of task, what procedure should the
agent follow?*

The catalog is [`docs/skills/README.md`](skills/README.md). Load a matching
skill only when the task matches a catalog row. Skills are procedure. They
may point at authority; they must not restate it as a second home. There is
no minimum skill count.

v1 ships two skills, chosen from recurring work that is **not** already
one load away in `CLAUDE.md`:

- **forecast-runtime** — Forecast / plan-policy / household-facing figure
- **evidence-intake** — absorbing owner-supplied evidence

Bounded implementation and exact-head review already live in `CLAUDE.md`,
which is always loaded. v1 does not copy them into skills.

### 3. Learned technical lessons — durable, never authoritative

[`docs/lessons/TECHNICAL.md`](lessons/TECHNICAL.md) holds engineering
lessons traced to a PR, commit, review, test failure, or incident.

Load lessons **selectively**. A skill may cite specific lesson IDs. When a
recurring failure seems relevant, search that file for terms related to
the current task. Do not read the whole store at the start of every
implementation. The store is allowed to grow.

A lesson may warn an agent away from a repeated mistake. It may **not**:

- invent or override a household financial fact
- invent or override owner policy, risk tolerance, reserve targets,
  spending permission, borrowing permission, debt strategy, or goal
  priority
- change Forecast calculations
- become a second planner, store, schema, or authority
- silently promote itself into `ARCHITECTURE.md` or `CLAUDE.md`

That is the hard boundary this architecture exists to keep. Learned memory
is cheap. Household truth is not.

---

## What an agent may write

No new permission system. Repository review already enforces this.

| Surface | Agent may |
|---|---|
| Chat / local scratch | Write freely. Never the handoff. Never household truth. |
| `docs/lessons/TECHNICAL.md` | Propose or add a lesson **with provenance** in a reviewed PR, under [`lessons/README.md`](lessons/README.md). |
| `docs/skills/` | Change only through a reviewed PR. Procedure, not authority. |
| `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE.md`, build strategy | Reviewed PR only. Do not silently restate a rule into a skill or lesson instead of updating the owner. |
| Household financial facts | Existing evidence / reconciliation path only. Never from memory. |
| Owner policy, priorities, permission to spend or borrow | Owner only. |
| Forecast behavior | Reviewed PR with independent proof. Skill/lesson text cannot substitute. |

---

## Portability

`AGENTS.md` is the one portable router. Vendor files are adapters:

- `CLAUDE.md` — historical filename; binds every surface equally
- `CHATGPT.md` — thin ChatGPT cold-start adapter
- `.github/copilot-instructions.md` — thin Copilot router
- `.claude/` — tooling only; no independent authority

Cursor, Codex, Claude Code, Copilot, and any later approved surface load
the same authority and the same skills. Do not maintain a second brief per
vendor.

---

## Future dreaming — documented, not implemented

An out-of-band review could periodically inspect historical PRs, reviews,
failures, corrections, and agent interactions and **propose**:

- missing lessons
- stale lessons
- conflicting instructions
- missing skills
- unnecessary procedures
- repeated architecture failures
- repeated review churn
- candidate simplifications

It must ask both:

1. **What rule or lesson are we missing?**
2. **What process or rule should we remove because it no longer protects a
   demonstrated hard safety property?**

It must **only propose**. It must never autonomously rewrite Atlas
authority, financial facts, owner policy, Forecast behavior, or security
boundaries. Any adopted change is a normal reviewed pull request, citing
the evidence that caused the proposal.

v1 does **not** add a memory database, vector store, embeddings, background
agent, or dreaming service.

---

## Simplification is a first-class outcome

Do not respond to every historical failure by adding another rule.
`CLAUDE.md` already owns the governance-control lifecycle: a new hard
control needs a demonstrated failure, a deterministic predicate, a focused
test, and a retirement condition.

This architecture applies the same rule to agent context. Adding a skill or
lesson is legitimate. So is deleting one. Prefer the smallest system that
still protects financial correctness, security, privacy, production writes,
destructive/schema changes, and explicit owner authority.

### Overlap noticed in v1 and left in place

These are not silent second authorities. They are known copies or ceremony.
Dreaming, or a later one-outcome docs PR, may propose thinning them. This
PR does not.

| Overlap | Why it stays for now |
|---|---|
| `CLAUDE.md` is always loaded and is long | Destacking it into skills would move operating authority. Too large for v1. |
| `CONTEXT.md` standing rules overlap `ARCHITECTURE.md` | `CONTEXT.md` already defers the secret boundary. Further thinning is a separate outcome. |
| `AGENTS.md` / Copilot router restate "Forecast is the calculation authority" | A one-line reminder at the router is cheaper than a missed load. Not a second home. |
| Review protocol appears in `CLAUDE.md`, the PR template, and workflows | `CLAUDE.md` owns the rule; the others are the card and the machinery. |
| `docs/advisory/` dated audits | Already explicitly non-authoritative. Not a lessons store. Do not merge the two. |

Retired process that already proved the simplification rule, and must not
be revived as "context architecture": machine-scored scope narratives,
review-round accounting, and treating independent agent review as a merge
lock (`docs/RISK_LABELS.md`). Also not a context-architecture control:
freezing the current skills/lessons layout in `npm test`.

---

## Runtime financial behavior

v1 changes **no** Forecast calculation, **no** `data.json` figure, **no**
page renderer, **no** refresh writer, and **no** security gate. If a later
edit to this file would require a household-facing figure to move, that
edit is in the wrong file.
