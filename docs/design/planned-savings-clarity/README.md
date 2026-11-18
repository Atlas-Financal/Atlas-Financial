# Planned Savings dropdown: goal stock and period contribution

The owner requested a compact Savings dropdown showing each goal's total saved
against its current need, plus the amount proposed for the selected period.
This isolated presentation slice starts from `f469fbe` main. The approved v3
reference was subsequently closed at the owner's request; later owner directions
govern this dropdown. The complete visual target is not claimed finished.

## Implemented

The active compact waterfall calls the existing `calendarWaterfallHtml` renderer
with the same Forecast savings inventory used elsewhere. Each visible row prints
the published goal label, currently backed savings / current goal requirement,
and a separately published selected-period proposal. Shared goals appear once;
the renderer never sums pool backing or grouped contributions.

The waterfall deduction remains the selected period's published proposed funding
amount. It is not total savings, confirmed fulfillment or money already moved.
The proposal requires the Forecast source, selected-period basis and as-of stamp
to match the sealed current Budget publication. Missing or mismatched publication
cannot supply the dropdown proposal or numeric deduction.
Dates, provenance, complete cost roster, assignments and existing financial
evidence remain reachable through the collapsed, keyboard-accessible Info
disclosure. Missing funding is stated once; a published shortfall remains visible.

## Exact publication gap

`Forecast.savingsInventory` owns total goal backing and goal requirements.
Configured `pools[].plannedGoals` can supply names and requirements while actual
backing assignments are unconfirmed. Those rows show Unknown saved, never zero.
Stale observations or a pool deficit likewise withhold total backing.

`Forecast.budgetPeriodProgress.savings.goals[].proposal` owns selected-period
contributions for individual costs. It does not publish a grouped contribution
for a group reference. Grouped contributions remain Unknown rather than being
summed in the page. A missing inventory cannot be replaced by period requirements
or fulfilled contributions. The complete original roster remains inside Info.

The existing target is the current Forecast goal requirement; it is not a new
historical lifetime-cost total. Estimated targets retain their estimate label,
and both published bounds of a ranged requirement remain visible.

The next financial outcome is an authoritative typed goal publication pairing
total backing/current need with grouped selected-period proposals. Deadline-aware
allocation and a proposed distribution of unassigned committed pool cash belong
to Forecast, with independent conservation and trust proof. A read-only planning
scenario does not confirm actual assignments or adopt a canonical baseline.

## Independent proof and comparison

The invented ready case has 169.37 and 45.67 backed across two pools: total saved
is 215.04 against a 600.00 goal. With thirteen other 11.00 costs and 350.00 next
period capacity, the selected-period proposal is independently reconciled as
`60000 + 13*1100 - 16937 - 4567 - 35000 = 17796` cents. The dropdown therefore
prints **215.04 / 600.00** beside **177.96**, while the waterfall deducts only
177.96. Neither source nor input is mutated.

The browser runs actual `App.boot`, Forecast and the active renderer using
independent invented HTTP responses, with all external requests blocked. Eight
states at 1440, 390 and 320px cover unknown setup, known proposals, funding gaps,
confirmed backing, deficits, stale balances, combined backing and target ranges.
It checks geometry, complete evidence, keyboard reachability and exact focus
restoration. Its receipt records execution head and asset commit.

Before captures use public assets exported directly from immutable main
`f469fbe316c43d1068319a1ef4e80943d5e9c4c1`. These are screenshots of invented
scenarios, not authenticated production screenshots or household observations.

| State | Desktop | 320px |
|---|---|---|
| Unconfirmed assignments | [Before / after](comparison-unconfirmed-1440.png) | [Before / after](comparison-unconfirmed-320.png) |
| Confirmed invented backing | [Before / after](comparison-backed-ready-1440.png) | [Before / after](comparison-backed-ready-320.png) |

Reproduce the focused proof with `node test/test-planned-savings-clarity.js`. Its
browser half now lives in `test/browser-savings-stock-pending.js` (Playwright and a
browser required); the original browser suite was retired on 2026-11-18 (#904 triage).
The merge card records exact-head full-suite results and remaining platform or
hosted-check blockers. This draft does not grant merge or deployment approval.
