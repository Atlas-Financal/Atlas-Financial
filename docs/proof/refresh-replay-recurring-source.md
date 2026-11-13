# Preserve recurring evidence through refresh replay

Speed round 2, owner dispatch 2026-11-13, follows #1128. Baseline:
`d7be69e29acec49cff0ef3eeb1edcecbe8127d49`.

The live stage report named Forecast at 34.5–35.9 seconds and source replay at
19.1–19.9 seconds within a 44–46 second refresh. These are overlapping spans:
source replay includes its observer, overlay and Forecast evaluation.

## Measured cause and repair

`provider-observe` already consumes transaction `recurring_id` for existing
classification and identity rules. `server-observation-memory.sourceInputs`
dropped that field. An invented linked row therefore lost its existing flags
in the second observation. The changed Forecast arguments defeated
`operating-answer.createRefreshEvaluation`'s exact-input reuse, and complete
served-data inequality correctly prevented retention of the projected evidence.

The repair retains that scalar in the existing private source projection.
The original observer, classification/matching rules, Forecast, exact-input
comparison, complete replay-equality gate, freshness and invalidation rules all
stay in force. There is no new cache, completed-response reuse, timeout change,
provider request, store or public transaction field. A later read still observes
the retained source and computes Forecast afresh. Malformed objects, arrays and
nonfinite values remain refused by the existing scalar validator.

The source-field audit compared the projection with all three provider
normalizers: `recurring_id` was the only omitted top-level consumed field;
consumed tag and nested Plaid identity fields already had explicit projections.

## Realistic-size invented proof

`test/fixtures/refresh-replay-size-data.js` uses invented values and identifiers.
Only collection sizes match a count-only GET of the app's v2 provider window on
2026-11-13: 1,001 unique rows, seven pending, 82 distinct dates, 107 rows with
recurring links, three matching configured recurring identities. The unbounded
pending query's seven rows were already inside the window. The app's 99-day
lookback runs August 6 through November 13 (100 inclusive calendar dates).
These are current counts, not a reconstruction of the four historical refreshes.
The plan has 33 bills, seven debts, eight obligations, four incomes and 17 dated
costs, matching repository collection sizes. No live row, amount, provider ID or
merchant is copied into the fixture.

Run, after checking out the exact baseline separately:

```sh
node test/proofs/refresh-replay-before-after.js /path/to/base-checkout
```

Four cold processes run base/head/head/base with networking blocked and the
same invented acquisition. The projector's disk reads for spending periods and
identity rules receive explicit synthetic empty inputs as well. They execute
the real observer, overlay, refresh trust, Forecast and projected-source replay.
No competing suites were running.
On Node v24.22.1:

| Measurement | Baseline mean | Repaired mean |
|---|---:|---:|
| Complete local refresh | 8,742.38 ms | 4,068.53 ms |
| Process CPU | 10,891.90 ms | 5,336.71 ms |
| Source replay (nested) | 4,165.78 ms | 452.75 ms |
| Forecast calls per refresh | 2 | 1 |
| Observer calls per refresh | 2 | 2 |

Elapsed time fell 53.46%; process CPU fell 51.00%. The four complete served
responses have the same SHA-256, with no fields excluded:
`fa3106fb8583156d2b3c333614f9e7538b1cb2ec3768739041ea9f5dacbef4dd`.
All input hashes and receipt hashes excluding `evidence` also match. The sole
intentional receipt difference is that exact replay now earns private evidence
retention instead of returning null. Neither observation is skipped.

This measures local computation with invented acquisition, not deployed latency,
provider wait, worker startup/transfer or HTTP publication. Timing is diagnostic,
never a CI threshold; deployment remeasurement remains necessary.

## Regression contract

`node --test test/test-refresh-evaluation-reuse.js` exercises the real consumer.
The new recurring-link tests fail on the baseline: the replay drops both flags
and the scalar is missing. With the repair, both complete observation reports
match, one Forecast runs, retention qualifies, and the complete served data and
receipt equal an independently uncached evaluation. A later retained-source read
recomputes Forecast and produces the same data. Numeric/string/null/absent forms
and malformed fields are distinguished. Existing changed-input, failed-observation,
exception, mutation, privacy, concurrent-read and independent-MCP controls remain.

The largest demonstrated removable cost is the repeated entire Forecast, rather
than another internal search micro-optimization. No cadence repair from #1127 or
card-presentation work from #1130 is included.
