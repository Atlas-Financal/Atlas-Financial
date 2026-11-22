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
| OD-015 | 2026-11-17 | A figures-moved PR skips Dale's separate figures look when the private diff shows 0 household fields moved and a non-builder records it; a moved head re-runs the diff. | `CLAUDE.md` rule 16 ("Skip when 0"); `docs/PRIVATE_FIGURES_REVIEW.md` | [#821 6947634834](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6947634834) | settled |
| OD-016 | 2026-11-17 | Reviewed Lunch Money recurring items are the bill-schedule authority; `data.json` bills stay as the estimated fallback. A bill reads paid only from Lunch Money's own recurring match: an expected date it does not list as missing, plus a linked payment that passes the identity checks. | Code only so far: `scripts/provider-observe.js`, `scripts/live-plan.js`; the paid-status route follows the lead's design after #1282 closed (Plan #6 Lunch Money thread); no rule document yet | [#821 6956651970](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6956651970) | settled |
| OD-017 | 2026-11-17 | The same rule extends to pay; the existing salary matcher stays the income authority until replaced. | Not yet written into a file | [#821 6957060901](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6957060901) | settled |
| OD-018 | 2026-11-17 | Spending in an ungrouped Lunch Money category counts as Other spending; a missing budget group shows Unavailable, never zero. | Not yet written into a file | [#821 6958331123](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6958331123) | settled |
| OD-019 | 2026-11-17 | A bill's day comes from Lunch Money with no Atlas PR. Its note that the plan keeps the cadence is replaced by OD-023. | Code: `scripts/live-plan.js` (#1283); no rule document yet | [#821 6960564387](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6960564387) | settled in part; cadence superseded (OD-023) |
| OD-020 | 2026-11-17 | A linked payment counts in its occurrence's planned pay period; a second one in an already-settled cycle goes to To confirm. Which occurrence it settles comes from Lunch Money's own recurring match (OD-016); the earlier "earliest unsettled occurrence" design was dropped (#1282 and #1284 closed). | Not yet written into a file | [#821 6961042821](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6961042821) | settled (pay-period rule); mechanism superseded (OD-016) |
| OD-021 | 2026-11-17 | Consulting Grok Bot under rule 17 is paused for the current Lunch Money push; ledger edits stay Dale-confirmed. | `CLAUDE.md` rule 17 ("Consultation paused") | [#821 6964009921](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6964009921) | settled |
| OD-022 | 2026-11-17 | When today's cash cannot be confirmed, future pay periods still show their figures tagged estimated, not Unavailable; today's cash stays withheld. | Not yet written into a file; the change goes through the full lane | [#821 6964438984](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6964438984) | settled |
| OD-023 | 2026-11-17 | A bill's reviewed Lunch Money recurring item leads its cadence as well as its day; anything Atlas cannot map safely falls back to the plan's cadence, tagged estimated. | Not yet written into a file | [#821 6964438984](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6964438984) | settled |

## #821, 2026-11-18

| ID | Date | Decision | Rule lives in | Source | Status |
|---|---|---|---|---|---|
| OD-024 | 2026-11-18 | Rent received from a tenant into Bills counts as Other Income and is then moved to savings by the owner; it nets to zero. | No change needed: the Bills-to-savings transfer pair is an internal movement in `public/forecast.js` (`householdInternalMovements`), so the pair nets to zero | [#821 6978494592](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-6978494592) | settled |

## #821, 2026-11-19

| ID | Date | Decision | Rule lives in | Source | Status |
|---|---|---|---|---|---|
| OD-025 | 2026-11-19 | The Budget page shows no banner for a retained last full picture ("Showing the last full picture from … Today's update couldn't be completed: …"); the small "Last updated" line already says when the picture is from. It reverses the 2026-11-18 banner and matches OD-3: a dated or retained view is signalled by the small "Last updated" line only, and the dated-plan note shows only when that line cannot be printed. | `public/plan.js` (`budgetSurfaceHtml`); `ARCHITECTURE.md`, "Last non-withheld picture shown under a whole-plan hold" | [#821 7008553005](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-7008553005) | settled |

## Plan #6 thread (Slack), 2026-11-20

| ID | Date | Decision | Rule lives in | Source | Status |
|---|---|---|---|---|---|
| OD-026 | 2026-11-20 | Reviews move in-house: a separate Claude reviewer session (not a builder, not the lead, at a high model or reasoning level) replaces ChatGPT (Atlas) as reviewer of record, including for figures-moved changes. Same review rules and findings format; ChatGPT stands down from reviews. Historical Atlas records stay valid. | `CLAUDE.md` (Roles; Review routing and claims; The two review lanes; Atlas Contract / Systems Review) | Plan #6 thread (Slack), posted by Dale 2026-11-20 17:32 UTC; no public link (the Slack workspace address stays out of the repository); the lead holds the message link | settled |

## Lead session (ATLAS LEAD 12), 2026-11-22

| ID | Date | Decision | Rule lives in | Source | Status |
|---|---|---|---|---|---|
| OD-028 | 2026-11-22 | A decision Dale gives in a lead session takes effect once the lead records it on #821 with his exact words (question and answer), time and session; agents act on it without re-asking him, and the #821 record wins over this repository's text until the lead's docs PR (opened within 24 hours) merges. A relayed decision may change roles, routing, order, pace and household facts; it never loosens the two absolutes, Absolute data safety, the merge gate's independence, or owner-reserved stops 2–6, which still need Dale's own words given directly to the acting agent or posted by him. (OD-027, the reviewer change, is recorded by #1540.) | `CLAUDE.md` (Owner-reserved stops) | Dale, directly to the lead (this PR's builder) in the lead session, 2026-11-22: "I want to change the rules so this doesn't happen again"; asked "Is that the rule you want?" on the proposed rule with the owner-reserved exception, he chose "Yes, with exception (Recommended)" over "Yes, no exception"; recorded on [#821 7073730566](https://github.com/Atlas-Financal/Atlas-Financial/issues/821#issuecomment-7073730566) | settled |
