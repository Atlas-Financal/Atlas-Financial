# Each week's low is read from its own days

This is speed-up 6 (ATLAS LEAD 11, 2026-11-19).

## What was slow

After its day loop, `simulateModel` gives every week a low: the least of the
week's seed and its days' balances. It found each week's days by filtering
**every** day of the walk by date, once per week:

```js
Math.min(seed, ...daily.filter(d => d.date >= w.start && d.date <= w.end).map(d => d.balance))
```

That is weeks × days work on every simulation. The invented corpus walks long
horizons (about 60 weeks of about 400 days), and the searches run hundreds of
simulations.

On main `a08b3b5c`, these lines were about 520 ms of the 2,602 ms inside
`recommend` on the 60 invented figures evaluations, about 20%.

## The change (`public/forecast.js`)

Week `wi` reads only its own rows, `7·wi .. 7·wi + 6`, or fewer in a short
final week. It starts from the seed and uses `Math.min`, as before.

## Why the answer cannot change

- **The rows are the same.** The day loop pushes exactly one `{ date, balance }`
  row per walked day, in order. The only `continue`s in its body belong to the
  inner events loop. Week `k` starts on row `7k` and ends six days later, and
  the walk's dates are consecutive. So the rows the date filter picks are
  exactly rows `7k .. min(7k + 6, days − 1)`.
- **The low is the same.** `Math.min` over the same values gives the same
  result in any order: NaN stays NaN, −0 still beats +0, and an empty week
  gives its seed.

The fix relies on the one-row-per-day invariant, so the test holds it at every
walk. A future change that filtered or extended `daily` between the day loop
and the week pass, such as a measured-only push, fails the test instead of
letting this fix diverge.

## Proof (`node test/test-week-low-own-days.js`, 19 checks)

1. **At every walk the corpus makes** (1,758):
   - `daily.length === days`;
   - row `i` is the walk's day `i`;
   - every week starts on row `7k` and ends six days later;
   - all 89,712 published week lows equal the incumbent filter over every day,
     with the seeds taken before the week pass.
2. **The real week pass on crafted rows** gives the incumbent's answer,
   `Object.is` for `Object.is`. The cases are:
   - NaN;
   - −0 and +0;
   - a +0 seed with a −0 day;
   - a short final week;
   - a single day;
   - a seed below, and a seed above, every day;
   - ±Infinity.
3. **The same advice.** A reference copy with the incumbent filter gives
   identical advice on 63 cases:
   - the 60 invented figures evaluations;
   - two held-income worlds;
   - the 753-purchase world.
4. **Mutants are caught:**
   - a window from row `7wi + 1`;
   - a six-row window;
   - windows that ignore the short final week;
   - `<` in place of `Math.min` (by the crafted NaN and −0 rows);
   - a pass that forgets the seed;
   - a day loop that pushes only measured days.

## Timing (diagnostic)

The figures are in the pull request, measured against base `a08b3b5c`.
