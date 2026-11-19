# Forecast date-arithmetic memos

LEAD 10 (Dale approved, 2026-11-18): make the server-side Forecast measurably
faster with no change to any figure, no hosting change and no new dependency.
This is the first and safest of the three measured hotspots.

## What was measured

The measurement ran on main `3cfe9297` with the invented budget-surface fixture,
through the real `Live.applyForServer` path. Network was blocked, and each run
was a cold process, matching the per-refresh worker. One refresh made one
`Forecast.recommend` call, costing about 185–240 ms of a 250–320 ms refresh.
Temporary counters recorded the following.

| Hotspot | Measured |
|---|---|
| Date arithmetic | `addDays` called 39,200 times on 822 distinct inputs; `toUTC` 46,558 times on 222 distinct strings. Self time about 51 ms (toUTC 24.7 + fromUTC 26.6), plus `financialDate` 17.5 ms. About 30% of Forecast. |
| Payday feasibility search | About 60 `simulateModel` runs from `paydayAllocation`, 89–96 ms inclusive, about 40% of Forecast. |
| Simulation walk and event expansion | `simulateModel` 27 ms self; `expandEventsInternal` 12.5 ms self over 304 calls. |

## The change

`toUTC` and `addDays` in `public/forecast.js` remember their answers in two
bounded `Map`s, each cleared at 8,192 entries.

- Both functions are pure, and every remembered value is a primitive: a number
  or a string. A caller therefore cannot mutate a remembered result.
- Only a string date and a number offset are remembered. Any other argument takes
  the unmemoised path exactly as before.
- A call that throws is never remembered, because the error is raised before the
  store.
- A NaN from a malformed string is the same value either way.

One alternative was tried and left out. Reusing a single `Intl.DateTimeFormat`
in `financialDate` measured no gain (147 ms versus 148 ms mean), so it is not
included.

## Proof

- `node test/test-forecast-date-memo.js` (in `npm test`) runs 180 checks:
  - every date from 2019 to 2033 at 23 offsets, asked twice (252,034 calls),
    against an independent `setUTCDate` reference;
  - enough distinct inputs that the memo clears and refills;
  - malformed dates and offsets, which must give the same thrown error or value
    as the unmemoised code, on the first call and on a repeat;
  - an offset whose text and number disagree, and a date object whose `split`
    changes between calls, neither of which is ever memoised;
  - the `window.Forecast` browser load.
- Four mutants are all caught: the key ignoring the offset, non-number offsets
  memoised, non-string dates memoised, and wrong memoised arithmetic.
- `node test/profile-forecast-date-memo.js <base-tree>` is optional and not in
  `npm test`. It runs the 12 invented figures inputs at their own as-of date and
  at +3, +7, +14 and +30 days: 60 evaluations, with 60 distinct advice hashes.
  It uses three cold processes per tree, alternating. The complete JSON advice
  is identical between base and head for every evaluation.
- On this machine (Node 24.22.1), mean Forecast time was **3,322.5 ms (base)
  versus 2,073.6 ms (head), 37.6% lower** across the 60 evaluations. Through the
  live refresh path on the budget-surface fixture, 6 alternating cold runs gave
  **192.3 ms versus 146.7 ms**, with the served-data sha256 identical on every
  run.
- `node scripts/figures-snapshot.js` produces byte-identical output, 3.3 MB, on
  base and head, including every invented input.

These timings are diagnostic. They vary by machine and runtime and are not a CI
threshold. The regression contract is identical output.

## Not in this change

- The payday feasibility search, hotspot 2. It would mean memoising or pruning
  whole simulations, which needs its own semantic argument.
- Simulation and event-expansion work, hotspot 3.
- Module compile time per cold worker, about 40 ms, outside Forecast.
