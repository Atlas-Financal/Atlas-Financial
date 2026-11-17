# Owner decisions — index

**An index only.** Each row points to where a settled owner decision is
recorded and to the file that holds its rule today. The rule text lives in
that file, not here. When a row and its file disagree, the file is right
about the rule and this index needs a fix.

**Before asking Dale anything**, check this index and the Answered section
of [`01_OPEN_QUESTIONS.md`](01_OPEN_QUESTIONS.md). If a settled row
answers the question, do not ask it. If not, say "no settled row" in the
question.

**Adding a row:** when Dale settles something, add one row: an ID, the
date, one plain line (no amounts, payees or account details), the file
that holds the rule now, the source link, and the status. A later decision
that replaces one marks the old row `superseded` and names the new row.

Status: `settled` · `superseded`

Source links: `#821 <n>` is
`https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-<n>`;
`#765 <n>` is the same form on issue #765.

## Register on #765 (Plan #5, closed 2026-11-09)

The first register. #765 closed as not planned when Plan #5 was
superseded; its rows stay as history.

| ID | Date | Decision | Rule lives in | Source | Status |
|---|---|---|---|---|---|
| OD-001 | 2026-10-28 | Paid storage rejected; the free database project was the production target. | Nowhere current; the storage path is frozen by OD-010. | [#765 6477078981](https://github.com/Atlas-Financal/Atlas-Financial/issues/765#issuecomment-6477078981) | superseded (OD-010) |
| OD-002 | 2026-10-28 | The Savings deadline was a target, not a commitment. | Nowhere current; the deadline has lapsed. | [#765 6477078981](https://github.com/Atlas-Financal/Atlas-Financial/issues/765#issuecomment-6477078981) | superseded (lapsed) |
| OD-003 | 2026-10-28 | Storage reconnect: open a fresh connection before each operation; never re-run an uncertain write automatically. | Nowhere current; the storage path is frozen by OD-010. | [#765 6477078981](https://github.com/Atlas-Financal/Atlas-Financial/issues/765#issuecomment-6477078981) | superseded (OD-010) |
| OD-004 | 2026-10-28 | The S3 test boundary for the Plan #5 storage work. | Nowhere current; the storage path is frozen by OD-010. | [#765 6477078981](https://github.com/Atlas-Financal/Atlas-Financial/issues/765#issuecomment-6477078981) | superseded (OD-010) |
| OD-005 | 2026-10-28 | Builder capacity and PR handoffs for Plan #5 (operational, not a product rule). | None; Plan #5 closed. | [#765 6477615984](https://github.com/Atlas-Financal/Atlas-Financial/issues/765#issuecomment-6477615984) | superseded (Plan #5 closed) |
| OD-006 | 2026-10-29 | Future-period Savings publishes tagged estimated instead of being withheld. | `ARCHITECTURE.md`, "Owner simplification decisions (2026-10-29)", Decision 1 | [#765 6515217463](https://github.com/Atlas-Financal/Atlas-Financial/issues/765#issuecomment-6515217463) | settled |
| OD-007 | 2026-10-29 | "Still to fund" is needed minus saved, never below zero, tagged estimated. | `ARCHITECTURE.md`, same section, Decision 2 | [#765 6515217463](https://github.com/Atlas-Financal/Atlas-Financial/issues/765#issuecomment-6515217463) | settled |
| OD-008 | 2026-10-29 | A failed refresh shows the last good data with its date; restore-authority protection is not a release requirement. | `ARCHITECTURE.md`, same section, Decision 3 | [#765 6515217463](https://github.com/Atlas-Financal/Atlas-Financial/issues/765#issuecomment-6515217463) | settled |
| OD-009 | 2026-10-29 | The seven household scenarios define the release (Proposal C). | None current; Atlas 1.0 shipped 2026-11-16 (`CLAUDE.md`). | [#765 6515217463](https://github.com/Atlas-Financal/Atlas-Financial/issues/765#issuecomment-6515217463) | superseded (1.0 shipped) |
| OD-010 | 2026-10-29 | The ATLAS-080 activation path is frozen, not deleted (Proposal A). | `ARCHITECTURE.md`, same section, Proposal A; `CLAUDE.md` merge gate | [#765 6515217463](https://github.com/Atlas-Financal/Atlas-Financial/issues/765#issuecomment-6515217463) | settled |
| OD-011 | 2026-10-29 | GitHub Issues was to be the only backlog; the spreadsheet was retired (Proposal E). | `BACKLOG.md` is the work home today (`CLAUDE.md`, `ARCHITECTURE.md`). | [#765 6515217463](https://github.com/Atlas-Financal/Atlas-Financial/issues/765#issuecomment-6515217463) | superseded (`BACKLOG.md`) |
| OD-012 | 2026-10-29 | Repository visibility stays public. | `CLAUDE.md` rule 10 and owner-reserved stop 4 | [#765 6515217463](https://github.com/Atlas-Financal/Atlas-Financial/issues/765#issuecomment-6515217463) | settled; see [#821 6937247559](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6937247559), which records approval in principle to make it private, not yet reflected in `CLAUDE.md` |

## Payroll

| ID | Date | Decision | Rule lives in | Source | Status |
|---|---|---|---|---|---|
| OD-013 | 2026-09-25 | Use the 2027 estimated payroll for 2027 pay periods, marked estimated. | `public/forecast.js` (`DALE_PAYROLL_REGIME_FROM`, `projectedDalePayroll`); `ARCHITECTURE.md`, Plan payday operating sheet row; `data.json` `plan.payrollPlanningAssumptions` | Dale, 2026-09-25 7:43 PM PT, quoted in `ARCHITECTURE.md` and `public/forecast.js` | settled |
| OD-014 | 2026-11-16 | 2027 payroll uses the published 2027 statutory limits (#1244). | `public/forecast.js` statutory tables | [#821 6929505580](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6929505580) | settled |

## #821, 2026-11-17

Each is the lead's record of Dale's decision.

| ID | Date | Decision | Rule lives in | Source | Status |
|---|---|---|---|---|---|
| OD-015 | 2026-11-17 | A figures-moved PR skips Dale's separate figures look when the private diff shows 0 household fields moved and a non-builder records it; a moved head re-runs the diff. | `docs/PRIVATE_FIGURES_REVIEW.md`; `CLAUDE.md` rule 16 not yet updated | [#821 6947634834](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6947634834) | settled |
| OD-016 | 2026-11-17 | Reviewed Lunch Money recurring items are the bill-schedule authority; `data.json` bills stay as the estimated fallback; a bill reads paid only from a linked posted payment. | Code only so far: `scripts/provider-observe.js`, `scripts/live-plan.js`; no rule document yet | [#821 6956651970](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6956651970) | settled |
| OD-017 | 2026-11-17 | The same rule extends to pay; the existing salary matcher stays the income authority until replaced. | Not yet written into a file | [#821 6957060901](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6957060901) | settled |
| OD-018 | 2026-11-17 | Spending in an ungrouped Lunch Money category counts as Other spending; a missing budget group shows Unavailable, never zero. | Not yet written into a file | [#821 6958331123](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6958331123) | settled |
| OD-019 | 2026-11-17 | The plan keeps each bill's cadence; the day comes from Lunch Money with no Atlas PR. | Code: `scripts/live-plan.js` (#1283); no rule document yet | [#821 6960564387](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6960564387) | settled |
| OD-020 | 2026-11-17 | A linked payment settles the earliest unsettled planned occurrence, in that occurrence's pay period; a second one in a settled cycle goes to To confirm. | Not yet written into a file | [#821 6961042821](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6961042821) | settled |
| OD-021 | 2026-11-17 | Consulting Grok Bot under rule 17 is paused for the current Lunch Money push; ledger edits stay Dale-confirmed. | `CLAUDE.md` rule 17 not yet updated | [#821 6964009921](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6964009921) | settled |
