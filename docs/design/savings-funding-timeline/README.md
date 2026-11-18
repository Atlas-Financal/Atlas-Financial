# Hypothetical savings funding timeline: first publication slice

Source: the owner's explicit 2026-10-05 instruction to bring the audited funding
timeline into Atlas. Current main before editing is
`b754ae1901609fce4b49a1bb3e0ad14ea17d1427`. Its Savings dropdown separates saved
stock from a period proposal, but does not publish this conserved pool timeline.
Verdict: PARTIALLY FIXED; Forecast code is required.

## Contract

`Forecast.savingsFundingTimeline(plan, debts, asOf, opts)` is an estimated,
read-only hypothetical projection. `baselineTrajectory.savingsFundingTimeline`
publishes that separate packet. Existing baseline fields are unchanged.

The operating opening must match the financial as-of. Both configured purpose
pools need current CAD observations and clear pending evidence. Balances are
counted once; silver already inside a balance is not another input. Existing
goal references own requirements. No PDF targets, household amounts or inferred
historical assignments are stored in this change.

The new timeline validates both incumbent operating account identities before
calling the cash aggregator. Each requires exactly one explicit finite numeric
cent value; signed values and numeric zero are valid. Missing cash/breakdown,
absent or duplicate account rows, missing/null/string/nonfinite values and
unsupported fractional cents withhold the packet. The legacy cash helpers and
incumbent publications retain their existing behavior. This repairs the exact
`06cb895` Systems blocker: conservation is insufficient when an unknown opening
has already been coerced to zero on both sides of the comparison.

The incumbent coupled Forecast walk supplies daily changes after normal life,
required payments, card gravity and extra-debt deductions. Only uniquely matched
planned-cost cash components move to pool draws. A dated draw is counted once.
Known undated/range/out-of-horizon requirement margins stay protected, with gaps
disclosed and no invented payment date. The hypothetical 2027 bonus uses
Forecast's payroll amount but end-February timing before statutory accumulation;
it is never a verified deposit or advance cash. Unsupported income years are
withheld. This timing assumption does not rewrite the baseline projection.

Before a dated draw, a hypothetical top-up may use cash already present after
routine holds. At a full period close, contribution capacity excludes advances
already counted and protects the next period's routine hold, existing buffer and
uncovered card reserve. Contributions cover dated pool deficits in deadline
order. Residual without a known requirement remains in operating. This is not
the audit script's optional accumulation of all residual into the sports pool.

Every daily row reconciles operating plus both pools to the native cash walk
plus the two observed openings. Every period pool row reconciles opening plus
contribution minus draws to closing. Grouped projected contributions are
published by Forecast; pages must not reconstruct them.

`actualSaved`, `actualContribution` and aggregate `actualContributions` remain
null. Projection packets always carry `nature: hypothetical-projection`,
estimated trust and `actionPermission: not-granted`. Existing live instructions
remain fail closed. Confirmed-history reconciliation is intentionally withheld
in this first slice rather than overwriting actual purpose.

## Independent proof

The invented fixture begins with 90 operating and pools of 50 and 30. Its first
period receives 500, spends 70 on groceries, 30 on a required payment and 25 on
an ordinary bill: normal residual 375. A planned draw of 80 leaves a native net
of 295. A 70 advance and close contributions of 40 and 200 total 310. Operating
closes at 155; pools close at 240 and 70. Combined 465 equals native operating
385 plus the original 80 reserve, with no duplicate expense or savings.

The regression independently walks these invented events in cents, rather than
using Forecast event expansion as its oracle. It also checks the actual
baseline publication, immutable-main compatibility, unavailable evidence and
unknown actuals. No authenticated production data or credentials are used.

Additional invented cases exercise the real observation overlay's 80 uncovered
card purchase alongside a 20 buffer, stale/pending/malformed pool evidence,
ranged requirements, a clipped cycle, a genuine zero dated contribution and
visible deficits. A paired bonus/no-bonus projection has identical cash and
transfers before February 28; one legacy estimated bonus is replaced once and a
confirmed occurrence is withheld rather than retimed. Unsupported payroll after
the authorized year is not published. The unchanged baseline is compared with
immutable main for both ordinary and payroll-regime inputs.

Run `node test/test-savings-funding-timeline.js` and `npm test`. The browser
proof that once lived in `test/browser-planned-savings-clarity.js` was retired on
2026-11-18 (#904 triage). Its claims are covered by the node suites and by
`test/browser-savings-stock-pending.js` on the current Budget face (stock values,
placement, keyboard order, Info reachability and exact focus restoration).

| Unchanged existing Savings sheet | Desktop | 320px |
|---|---|---|
| Unconfirmed assignments | [Main / branch](comparison-unconfirmed-1440.png) | [Main / branch](comparison-unconfirmed-320.png) |
| Confirmed invented backing | [Main / branch](comparison-backed-ready-1440.png) | [Main / branch](comparison-backed-ready-320.png) |

These are actual App.boot screenshots with invented HTTP fixtures; external
requests are blocked. Main assets are exported from the immutable starting
commit above. Exact-head receipts stay outside tracked financial artifacts and
are reported in the merge card. The images prove this engine slice preserves
the current UI; they do not claim the remaining planner design is complete.

## Remaining slices and input gaps

The existing Savings waterfall must next consume this typed projection beside
saved/needed and selected-period contribution, using concise projection labels.
This engine publication alone does not finish the owner's planner or UI.
No renderer or dashboard is added here; desktop/mobile rendering is unchanged.

Confirmed starting assignments, payment settlement and several spring costs
remain unresolved or only in the private audit scenario. They must enter through
their existing evidence/input workflow without hardcoding illustrative targets.
The latest supplied financial opening must be used by the caller; no older
opening is silently reused. This PR changes no canonical household amount,
obligation, role, baseline assignment, credentials, store or financial action.
