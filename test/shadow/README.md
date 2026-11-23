# Independent Forecast shadow

`test/test-forecast-shadow.js` compares a generated native plan with the figures Budget reads. The expected-side authors used written rules and the names of input and output fields. `schedule.js`, `period.js` and `cash-card.js` load only one another. The `observed-*` adapters read the production publications. All cases start with invented amounts, dates and ledger-supplied identities. No fixture is extracted from a household snapshot.

## Rules exercised

| Figure | Independent method and written source |
|---|---|
| Operating period and income | Count 14-day intervals in either direction from the biweekly payroll anchor. Sum income occurrences from the current payday through the day before the next. A second salary on two monthly dates can contribute zero, one, or two receipts. It cannot start an operating period. Monthly day 31 clamps in short months. [Pay calendar](../../docs/ACCOUNT_FACTS.md) and [one plan, many windows](../../ARCHITECTURE.md#one-plan-many-windows--owner-approved-2026-08-12-refined-2026-08-16). |
| Bills and Balance After Deductions | Walk calendar days and assign dated bills, mortgage payments and credit minimums to the period of their effective date. An unpriced bill still has an identity and date. An authored zero price needs explicit no-payment evidence to count as known zero. Compare each listed row even when the total is withheld. Subtract assigned bills and the household hold from displayed income. [Period and input rules](../../ARCHITECTURE.md). |
| Household budget and Stack | For each generated category hold the greater of the target and its distinct ledger-labelled purchases, including pending ones. Sum those holds. Check the individual Bills, Household, Mortgage and Credit terms against Income and check the resulting surplus. This family has no held outflows, savings-item charges or beyond-minimum payments. [Budget authority](../../ARCHITECTURE.md) and [written Stack rule](https://github.com/Atlas-Financal/Atlas-Financial/pull/1426). |
| Cash over time | Start with the two operating accounts, apply scheduled movements on their dates, and carry the unrounded weekly allowance in sevenths of a cent. Compare every daily close, the lowest balance and the ending balance in cents. The long-horizon control also reconciles closing cash using a count of paychecks through leap day. [Cash-walk authority](../../ARCHITECTURE.md). |
| Card and HELOC minimums | Enumerate original monthly dates before filtering on the effective statement due date. A statement may replace one original without crossing a neighbor. For the fixed-interest rule, use the frozen statement balance and annual purchase rate, round one month's interest up to a whole dollar and take the larger of that and the issuer minimum. The HELOC cash minimum is separate from noncash capitalisation. Check original date, effective date, ID and amount. [Statement and cash-minimum contracts](../../ARCHITECTURE.md) and [fixed-interest decision](https://github.com/Atlas-Financal/Atlas-Financial/pull/1498). |
| Payment timing and credit limits | A pending minimum is still owed. An exact receipt already represented in today's opening prevents a second cash debit. Later-effective evidence cannot do so today. Compare the known posted and pending card stocks in integer cents against limits at equality and one cent on either side. [Settlement and headroom contracts](../../ARCHITECTURE.md). |

## Scope and interpretation

Dates are household financial dates. Weekend and holiday cases keep an authored contractual date. A statement override supplies a different due date. These tests make no inference about when a bank actually posted a transaction. Ledger rows arrive with explicit category or occurrence identity.

The cash walk is a daily plan. Its oracle includes the opening and each day's closing balance in the horizon low. The written rules do not specify a posting order for a same-day debit and credit with dates only. An intraday bank low can differ even when opening and closing cash agree. That distinction is recorded in the hunt report for the desk.

The statement contract rejects conflicting dates. The invalid-input property exercises the public event reader’s explicit conflict rejection. It also checks that the last legal day on each side of an original can publish the replaced payment.

The generated domain covers current-period recurring and one-time rows, explicit issuer minimums, known pending stocks, per-payday targets and independent transactions with distinct IDs. It does not model statutory payroll deductions, saved historical periods, account reconciliation, or a live overlay. An overdrawn operating account contributes its signed balance. No ledger pairing, deduplication or transaction naming is implemented here.

## Run and replay

```sh
node test/test-forecast-shadow.js
node test/test-forecast-shadow.js --runs=4096 --seed=20261123 --scan
node test/test-forecast-shadow.js --runs=4096 --seed=20261123 --field=cash.cards
node test/test-forecast-shadow.js --seed=20261123 --field=statement --path=0
```

The standard CI manifest runs the first command. The default is 2,048 cases per generated family. `--scan` checks every household field through the entire corpus, reports the first index for each failing field, and exits unsuccessfully on any difference. Replaying that field and index without `--scan` shrinks that specific disagreement. A saved shrink path is tied to its seed and generator revision. The `opening`, `statement` and `leap` selectors run their focused controls independently.
