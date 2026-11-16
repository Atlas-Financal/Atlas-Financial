# Travel Visa next annual-fee planning estimate - 2026-10-07

This is the minimum source and explicit-approval record for one future planning input. `data.json` `plan.bills` owns the input; Forecast owns its consequences. This record is not a posted balance, verified fee schedule, issuer statement, payment instruction or new settlement identity.

```evidence-ids
TRAVEL-VISA-ANNUAL-FEE-001
```

## Owner instruction and provenance

The owner requested a next Travel Visa annual-fee estimate of approximately **CAD 149 around October 6, 2027**, based on the owner-reported annual fee posted October 6, 2026. The ChatGPT decision desk delegated this independent, authorized planning follow-up after #541 merged at `c2f4ca19bba7a772be218bbc412da9920926d0ee` (source thread `01a0fe55-68a7-7255-a88c-1707cdede0e6`). No bank or provider read was performed for this change, and no institution statement was independently inspected.

The amount and next posting date remain **ESTIMATED**. The October 6 planning anchor is not an issuer payment due date, statement minimum or promise that the fee will post on that exact day. A later verified notice or posted charge can replace the estimate through the usual authorized input/evidence path.

## Exact canonical preview and authorization

Append one row to `plan.bills`, id `travelvisa-annual-fee-2027`:

| Field | Proposed value |
| --- | --- |
| Label | Travel Visa annual fee |
| Frequency | `yearly` - native annual planning cadence |
| First planning occurrence | `firstDue: 2027-10-06`, month 10, day 6 |
| Amount | `149` CAD |
| Amount trust | `confidence: estimated` |
| Date trust | `dateConfidence: estimated` |
| Paying account | canonical `travelvisa` |
| Joint cash | `jointCash: false` - existing card-paid reserved-gravity path |
| Household category | none (`budgetCategory: null`) |
| Provenance | owner-authorized estimate and owner-reported 2026-10-06 basis in the row note |

`docs/skills/evidence-intake.md` step 4 permits canonical writes through the earned preview/approve path **or an explicit owner-approved edit recorded on the merge card**. This request supplies the exact amount, estimated date, account, trust and purpose; it covers this input edit. The provider balance-refresh CLI supports posted-state/cutover approvals and does not author a new planned bill. Its allowlist is not extended, and no unsupported balance-refresh apply is used. The isolated local preview names the exact added row and confirms there is no edit to existing canonical rows, opening or debt stock.

## Preservation and closure

This adds no 2026 event, historical arrears, issuer due date, payment, minimum confirmation or provider identity. The native annual model projects later anniversaries as estimated; these are not confirmed charges. Actual future fee amount, timing and whether the card remains open still require later evidence. The already-posted 2026 fee retains its existing Other Spend/card-coverage treatment. Existing scheduled monthly fees remain separate. Opening, balances, pending amounts, savings assignments, all prior bills/commitments, category policy and financial evidence remain unchanged.

The existing `Forecast.expandEvents`, yearly card-paid funding sequence and Plan Spend consume this dated input. A once-only card bill is not included by the native planned-spend selector; yearly with firstDue uses the established annual-fee representation without runtime work. No Forecast, renderer, provider, runtime or test-registry code is changed. Independent tests use invented amounts/dates/accounts, not the owner amount or a copied/scaled ledger. Exact-head financial and trust verification is required before merge; the builder does not merge.

## Independent verification

`node test/proof-travel-visa-annual-estimate.js` passes three proof groups: exact canonical semantic scope (removing the added row reproduces base main byte-independent JSON values), an invented annual card-reserve ledger, and preservation of current-year unexpected-fee treatment, native card coverage and observed cash/debt. The invented example reserves 73.41 once in April 2031 and creates no chequing bill debit or settlement. Its prior-year window is empty; later annual projections retain estimate trust. The new standalone proof is intentionally not added to the shared registry owned by another task.

Six incumbent suites pass: evidence-use register, authority coverage, Forecast, yearly card-paid bill behavior, month-end bill reconciliation, and the scheduled-fee allowance contract.

The optional `node test/browser-travel-visa-annual-estimate.js [installed-browser] [local-output]` uses the actual Budget page boot (the Plan spend page it first ran against was deleted 2026-11-16; the estimate is now asserted in the Budget funding item and goal row), independent invented observations, and no external requests or writes. Desktop 1440, mobile 390 and narrow 320 pixels pass estimated-label/cash-date/native card-paid checks, keyboard details and overflow checks. The page labels the date **Cash date** and the row **ESTIMATED**. It does not publish an issuer payment due date. No real financial screenshot is included.

- [Invented desktop consumer](../proof/travel-annual-estimate-1440.png)
- [Invented 320px consumer](../proof/travel-annual-estimate-320.png)

The native general bill event does not separately publish `dateConfidence`; that metadata stays on the input while the live Plan Spend consumer publishes overall ESTIMATED trust and cash-planning date terminology. No trust runtime is changed or a date promoted to verified.
