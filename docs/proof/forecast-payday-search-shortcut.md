# Payday feasibility search: fewer probes, same boundary

This is LEAD 10 hotspot #2. Dale approved the free Forecast speed-up on
2026-11-18, and the lead ruled this design on 2026-11-19 after a semantic
argument. It follows the date-arithmetic memos (#1392,
`docs/proof/forecast-date-arithmetic-memo.md`).

## What was slow

`paydayAllocation` asks `maxFeasiblePaydayRemoval` for the largest removal on
the as-of date at which `protectedPlanCheck` still holds. It asks once for
the whole plan and once more for each protected future row. Each search
bisects to the cent, and every probe is a full simulation.

On the 12 invented figures inputs at 5 as-of dates, there were 109 searches
and 1,788 probes, about 16 per search. The search was about 40% of Forecast
on the budget-surface fixture.

## The change (`public/forecast.js`)

1. **A probe is never repeated within one search.** Each cent amount's check
   result is remembered for that search only. The old code re-ran two probes
   it had just made: `fits(-add)` after the doubling loop, and `fits(hiC)`.
   This needs no assumption.
2. **The top probe points at the boundary.**
   - When the top probe fails and every failure carries a finite, positive
     dollar shortfall, the candidate boundary is `g = hi − ceil(largest
     shortfall)`, in cents.
   - `g` is used only if it lies in `[lo, hi)`, `fits(g)` holds and
     `fits(g + 1)` does not.
   - If `fits(g + 1)` also holds, it tries one cent on: it uses `g + 1`
     when `fits(g + 2)` does not.
   - In every other case the bisection runs exactly as before. That covers
     no numeric shortfall (for example a card-coverage failure, the
     all-infeasible doubling case), a guess out of range, or a failed
     verification.

## Why the boundary cannot change

The search already assumes that feasibility is monotonic in the removal
("Monotonic in the removal, so the cent search is exact"). Under that
assumption, the bisection's answer in `[lo, hi)` is the one cent `b` with
`fits(b)` and not `fits(b + 1)`. A verified `g` is that same `b`. The
shortcut adds no assumption of its own; where verification fails, the old
search decides.

The assumption is tested, not just stated. `test/test-payday-search-shortcut.js`
sweeps 21 removals across three times each search's range, at two as-of
dates. No feasible removal appears above an infeasible one, and every
returned in-range boundary is a real edge.

## Proof

`node test/test-payday-search-shortcut.js` is part of `npm test` and runs in
about 7 seconds. It builds the full binary search from the same source, with
the memo and the shortcut switched off, and compares against it:

- **Same boundary:** on all 12 invented inputs at their own as-of date and at
  +3, +7, +14 and +30 days (60 evaluations), every search returns the same
  boundary (109 of 109), and the complete advice JSON is identical.
- **Fewer probes:** 1,788 → 660, 63% fewer.
- **Order holds:** the monotonicity sweep and edge check described above.

The test catches each of these mutants:

| Mutant | Failures |
|---|---|
| No `!fits(g + 1)` verification | 21 |
| The one-cent-on case returns `g` | 21 |
| Guess from the smallest shortfall with no verification | 20 |
| The memo stores under the wrong cent | 65 |

Other evidence:

- `node scripts/figures-snapshot.js` is byte-identical on base `e919f021` and
  head (3.3 MB, all invented inputs included).
- `node test/profile-forecast-date-memo.js <base-tree>` (optional) finds the
  complete advice identical on all 60 evaluations against base `e919f021`.
  Mean Forecast time fell from **2,177.5 ms to 1,630.0 ms (25.1% lower)**,
  on top of #1392.
- Live refresh path (`Live.applyForServer`, budget-surface fixture, 3
  alternating cold runs each): Forecast fell from **158.5 ms to 108.5 ms**,
  with the served-data sha256 identical. On the invented harness world with
  753 transactions, total compute fell from 2,358 ms to 1,950 ms, with
  served data identical.

These timings are diagnostic: they vary by machine and runtime, and none is
a CI threshold. The regression contract is the identical boundary and
identical output.
