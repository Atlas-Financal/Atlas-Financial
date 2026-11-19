# The walk's date list: built once, same dates

This is speed-up 4 (ATLAS LEAD 11, 2026-11-19). It follows the weekly search's
held-income holder (#1406, `docs/proof/forecast-weekly-search-held-income.md`).

## What was slow

`simulateModel` walks the plan one day at a time. On every day of every walk
it called `addDays(start, i)` to name that day.

The searches walk the same days from the same start on every probe. The
date-arithmetic memo (#1392) still built a text key for each call and looked
it up.

On main `9d472959`, `addDays` was 15% of the time inside `recommend` on the
invented figures inputs, measured over 60 evaluations. 449 ms of its 658 ms
came from that one line.

## The change (`public/forecast.js`)

- `walkDateList(start, days)` returns `addDays(start, i)` for each `i` in
  `[0, days)`, as a frozen array.
- The last list is kept and handed back only for exactly the same start and
  length. Any other start or length builds a new one.
- `simulateModel` reads `walkDates[i]` in place of calling `addDays(start, i)`.

A walk cannot read past its list: the list is handed back only when its length
equals the requested days, and the loop reads only indexes below that.

## Proof (`node test/test-walk-date-list.js`, 12 checks)

1. **The same dates.**
   - Every start from 2019-01-01 to 2033-12-31 is asked at lengths 0, 1, 7, 28,
     91, 92, 182, 365 and 400. The requests are ordered so the same length
     follows a different start, and a different length follows the same start.
   - All 21,916 lists match an independent calendar reference (`setUTCDate`)
     date for date.
   - All 53 distinct (start, length) pairs the corpus walks also match.
   - A kept list is frozen: a write throws and changes nothing.
   - Another start or length builds a new list.
2. **The same advice.** A reference copy that calls `addDays` on every day gives
   identical advice on 63 cases:
   - the 60 invented figures evaluations (12 inputs at +0/3/7/14/30 days);
   - two held-income worlds;
   - the 753-purchase harness world.
3. **Mutants are caught**, by the sweep in 1 or by the advice in 2:
   - **An off-by-one list.** The advice differs on 63 of 63 cases.
   - **A list kept across a different start.** The sweep finds 9,740 lists
     wrong.
     - On this corpus no two walks in a row share a length but not a start,
       so this mutant changes no advice here. The sweep asks for exactly that
       pattern.
   - **A list too short for the requested length** (kept for any length). The
     advice differs on 63 of 63 cases.
   - **A longer kept list whose own length drives the walk.** The advice
     differs on 10 of 63 cases.

## Equivalence and timing (diagnostics, not thresholds)

- `figures-snapshot.js`: byte-identical on base `9d472959` and on head.
- Timing figures are in the pull request.
