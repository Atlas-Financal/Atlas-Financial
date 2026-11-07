# Atlas 1.0 acceptance scoreboard

`npm run scoreboard` runs every scenario here against the current build and
prints, for each of the seven Budget checks adopted in #787 6593395684 (full text 6622324225), how
many scenarios pass. It is a scoreboard, not a gate: it always exits 0, and
it is not part of `npm test` or any required CI check.

| File | Check |
|---|---|
| `check-1.js` | Future periods reconcile |
| `check-2.js` | One savings pool reconciles |
| `check-3.js` | Trip spending belongs only to its trip |
| `check-4.js` | Owner-paid items turn green and leave future funding |
| `check-5.js` | Closed periods preserve history and trust labels |
| `check-6.js` | Bills match dates, amounts and payment evidence |
| `check-7.js` | Transactions appear once, sorted, with item-only notes |

## What one scenario does

Each scenario is end to end, through the same path production uses:

1. an invented raw Lunch Money payload (accounts, transactions, coverage);
2. `scripts/live-plan.js` `fromObservation`, which runs
   `scripts/provider-observe.js` and overlays the result exactly as
   `server.js` serves `/data.json`;
3. the real `public/index.html` boot (`forecast.js`, `plan.js`,
   `savings-inventory.js`) in headless Chromium, with every request
   intercepted;
4. assertions on the rendered Budget page text, stepping pay periods or
   reloading where the scenario spans them.

Expected values are written by hand from the spec and the invented inputs.
No scenario computes an expectation by calling Atlas code, and none reads
`data.json` or any household figure. The one exception is 1.6 (audit C7),
which has no Budget control today and runs the page's own `Forecast.simulate`
against a hand-derived total.

## The served opening

The canonical document is dated at the Oct 9 payday opening (or the live day
when that is earlier) with no `priorAsOf`, as production's canonical document
is. `scripts/live-plan.js` then advances it to the live day and writes
`priorAsOf` and the matched postings itself, so a bill posted between the two
dates is matched once and not deducted again. Without a Savings pool, Savings
is observed as household cash, the observer's unconfigured-Savings shape.

Limit: the canonical balances are the world's live-day balances, now dated
Oct 9, so the payday-morning snapshot live-plan records from them is not
derived from the Given. No scenario asserts that snapshot today; a scenario
that tests a payday opening must set the canonical balances it means.

## Expected failures

A scenario with `fixedBy` is expected to fail until that PR or slot lands
(for example `A4b`, `A5`, `A7a #841`, `A11 #818`, `C1`). It still runs and
shows as failing. When one starts passing, the board lists it under "Now
passing although marked": remove the mark in the same PR that fixed it.

## Sources and `basis`

Every scenario carries a `basis`; the board reports all scenarios and, in a
second column, the adopted ones (`spec` + `blueprint`).

- `spec`: the adopted 1.0 acceptance spec, #787 6622324225, moved onto this
  harness's invented October calendar (each file says how).
- `blueprint`: the adopted A4/A5 blueprint (#787 6620986508 §3–§5) and the
  bills/sorting blueprint (#787 6595179923).
- `audit`: the C1–C7 repros, #787 6621636966, scheduled in 6621646116.
- `derived`: extra guards derived from the one-line check and the trust
  rule. They are kept, but they are not the acceptance definition.

Shapes that do not exist on `main` yet are isolated in one place each:
item links use the A4a (#840) account-map `savingsLinks` shape (`w.links` in
the harness); a partial owner confirmation is written as `settledAmount`
(`confirm()` in `check-4.js`).

## Options

```
node scripts/acceptance-scoreboard.js [--check <n>] [--verbose] [--json <path>]
```

The JSON report (counts, scenario ids, pass/fail and the first failure line)
goes to the OS temp directory unless `--json` names a path.
