# Weekly cap search: the held-income set is built once per search

This is speed-up 3 (ATLAS LEAD 11, 2026-11-19). It follows the payday search
shortcut (#1398, `docs/proof/forecast-payday-search-shortcut.md`).

## What was slow

Every forward walk asks `heldOtherIncomeKeys` for the expected Other Income
it must not rely on. Each build runs `calendarIncomeSections` over the live
transactions, so the cost grows with the size of the ledger. The payday
search already hands its probes one holder (#980 follow-up). The weekly cap
search (`recommendWeekly`) did not, so it rebuilt the set on every probe.

The profile on main `f3f8a4c2` used a harness world with 753 invented
purchases (567 on or before as-of). There, building the hold set was 37% of
the time inside `recommend`, and the weekly search was the largest single
caller.

## The change (`public/forecast.js`)

1. `recommendWeekly` creates one `{ plan, entries: [] }` holder per search
   and passes it on every probe.
2. `weeklyVariable` joins `HELD_OTHER_INCOME_PROBE_ONLY`, the option keys the
   holder ignores when matching. The weekly probes differ only in that key.
   - `seq` needs no entry. It is one object for the whole search, so it
     matches by identity.

The holder still lives for one search only. Any other differing option still
misses and recomputes. A call without a holder computes exactly as before.

## Why the advice cannot change

`weeklyVariable` is spent day by day in `simulateModel`. Neither the event
expansion nor the hold set reads it. `test/test-weekly-search-held-income.js`
proves this mechanically rather than by inspection:

- At 645 captured weekly probes, it changes `weeklyVariable` alone. The
  values are 0, 5, 1,234, 80,000, −500, NaN, 1e9, and removed.
- Across 2,424 variations, `expandEvents` is byte-identical and the hold set
  is identical. Some of those hold sets are non-empty.
- Two copies that do read the key are caught: one reads it in the hold set,
  the other in the expansion.

## Proof (`node test/test-weekly-search-held-income.js`, 15 checks)

1. **The key does not reach.** The isolation check above.
2. **Same advice.** A reference copy with the weekly holder off gives
   identical advice on 63 cases:
   - all 60 invented figures evaluations (12 inputs at +0/3/7/14/30 days);
   - two held-income worlds (`test/fixtures/held-other-income-search-world`);
   - the 753-purchase harness world.

   A holder that forgets the hold set changes the advice on both held worlds,
   so this comparison can fail.
3. **At most one build per search and walk start, on equal search work.**
   Both sides run the same 85 searches and 545 probes, holder off versus on.
   - Builds drop from 308 to 44, one per search and walk start.
   - The holder keys its entries by the walk's start date. On some worlds a
     search walks from as-of and from the pay period's start, so it needs one
     hold set for each.
   - On the 753-purchase world: 24 builds → 2 (one search, two starts).
4. **Degraded holders fail check 3.** Each of these is caught:
   - a holder that never stores;
   - `weeklyVariable` kept as a match key;
   - a holder that stores only every other build;
   - a holder that looks up only every other call.

`test/test-held-other-income-search-equivalence.js` counted builds inside
payday searches only. It now counts a weekly search as a search too, and its
"at most one rebuild per search" check holds unchanged (19 of 19).

## Equivalence and timing (diagnostics, not thresholds)

- `figures-snapshot.js`: byte-identical on base `f3f8a4c2` and on head
  (3.3 MB).
- 753-purchase world, through the full refresh path (mean of 3 runs):
  - total compute 1,824 → 1,505 ms (about 17% lower);
  - the Forecast stage 741 → 688 ms;
  - the served-data digest is identical.
- The 60 invented evaluations: no measurable change, and the advice digest is
  identical. These worlds carry few transactions.
