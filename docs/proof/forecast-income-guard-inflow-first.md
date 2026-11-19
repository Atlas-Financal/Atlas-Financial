# The income guards check the inflow first

This is speed-up 5 (ATLAS LEAD 11, 2026-11-19).

## What was slow

The held Other Income set is built many times per `recommend`. Each build runs
`calendarIncomeSections`, which asks two functions about every packet
transaction in its span:

- `isGenuineOtherIncomeTransaction`;
- `isExpectedIncomeSettlementCredit`.

Both first rejected a row on the Amanda-tennis account text
(`isTennisIncomeAccount(personalAccountText(tx))`). Only after that did they
reject anything that is not an inflow. So every debit, which is most of a
ledger, built a six-field account string and ran a regex, only to be rejected
as not an inflow.

On the 753-purchase invented harness world (main `311c6c7b`), that string and
regex were about 50 ms of the 1,035 ms inside `recommend`.

## The change (`public/forecast.js`)

In both functions the inflow guard now runs before the tennis-account guard.
Nothing else moves.

## Why the answer cannot change

Both guards only reject (`return false`) and change nothing. Of two such
guards, the order decides only which one rejects, not whether the row is
rejected. The order shows in one case only: a guard that throws.

`personalAccountText` turns account fields into text, so it could throw on a
field whose own `toString` throws. Every row the corpus asks about carries
plain values in each field these guards read. The test checks this, and shows
the one difference on a deliberately non-plain debit: the old order threw, and
the new order rejects it as not an inflow.

The early tennis guard decides no answer on its own. Later,
`txMatchesScheduledIncome` rejects the same account text before either function
can answer true. The early guard only rejects sooner, which is why its place is
free.

## Proof (`node test/test-income-guard-inflow-first.js`, 13 checks)

1. **Row by row.** 63,016 corpus calls and 34 answers on invented rows
   (17 rows through both functions) give the same answer in both orders.
   - The invented rows cover tennis-account credits and debits, household
     cash, reserves, internal transfers, an ATM deposit, refunds and flagged
     income.
   - 364 of the asks are credits that reach the tennis guard.
2. **Rows are plain.** Every asked row carries plain values in each field the
   guards read. The non-plain debit case behaves as described above.
3. **Same advice.** The advice is identical on 63 cases:
   - the 60 invented figures evaluations;
   - two held-income worlds;
   - the 753-purchase world.
4. **Mutants a slip here could make are caught:**
   - no inflow guard in the income test;
   - the settlement inflow guard flipped;
   - a tennis test that also matches household chequing.

   Removing the early tennis guard is shown to change no answer.

## Timing (diagnostic)

The figures in the pull request come from a same-source comparison against
base `311c6c7b`.
