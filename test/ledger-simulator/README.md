# Invented ledger simulator

From the repository root, run two seeds for one calendar month with the first command. The second starts at seed 500 and runs four households for three months. Use Node 24.22.1.

```sh
node test/ledger-simulator/run.js --output simulator.json
node test/ledger-simulator/run.js --seed 500 --seeds 4 --months 3 --output simulator.json
node test/ledger-simulator/run.js --replay-report simulator.json
```

The JSON contains the ranking, the affected figures, the independently expected cents, the observed values, and the reduced inputs. The replay command rebuilds every saved witness from its seed and selected rows, checks its failure signature, and compares its expected and actual values with the report. Omit `--output` to print JSON. Elapsed time goes to stderr. A completed run with financial findings exits 0. An execution error, missing required witness, failed control or unreproducible finding exits 2.

## Choose the sample

```sh
node test/ledger-simulator/run.js --list
node test/ledger-simulator/run.js --rate topup-late=0.4 --rate pending-drift=0 --output simulator.json
node test/ledger-simulator/run.js --known-six --seed 173 --seeds 1 --output known-six.json
node test/ledger-simulator/run.js --controls
node test/ledger-simulator/run.js --advisory --output advisory.json
```

Each dial is a probability per eligible day. A monthly bill draws on its scheduled or deliberately displaced day. Each draw is keyed by seed, habit and day, so changing one dial preserves the other draws. The report records the habits that actually occurred. Independent controlled cases also exercise each dial in the default run. A single-fixture check can still run when its random frequency is zero. Advisory CI uses the same fixed seed, seven days, common and rare consensus cases, and one controlled exposure to every sync fault.

## What the replay measures

The economic journal records purchases, replacements, transfers and signed postings in integer cents. A separate stream of provider rows has transaction dates, arrival dates and optional withdrawal dates. The account balance is posted stock, including when separate transaction evidence is pending or late. The stale-balance fault uses yesterday's stock and timestamp. Processor names, prices, ledger identifiers and account labels are synthetic. Stable canonical IDs that appear in the product's hard-coded role protocol are used only in their schema roles.

The test uses the acceptance harness's canonical opening, provider payload, account map and identity builders. An in-process loopback GET transport drives the production paginated Lunch Money reader. For a mid-read edit, the same row appears on overlapping pages. The second read sees its new category. An unchanged overlap is independently checked for a single surviving purchase. The input then goes through `Live.fromObservation` and the Stack's `Forecast.budgetRecommendInputs` and `Forecast.recommend` entry points. The test reads their published rows, totals and action objects. Browser rendering, hosted refresh workers, durable period-close archives and live provider activity are outside the measured path.

Every calendar day gets a clean reading. The injected faults fork the same economic history one at a time. A paired control starts from yesterday's qualified observation when available. The continuous clean timeline also carries qualified observations forward. The cold and warm controls check that the prior card amount can survive a thin reading while today's independently priced grocery total advances. Unavailable values retain their distinction from a measured zero.

The eight checks cover purchase ownership, transfer neutrality, row totals, agreement between published figures, unrelated blocks under one fault, OD-045 retention, refresh exceptions and money-move advice on unresolved evidence. Worked examples change one published result at a time and require the corresponding oracle to detect it. Separate consensus predicates require both symptoms of the top-up case, the line payment and its extra deduction, both payer debits and both issuer receipts on one card, a still-due bill plus the same debit in Other, the schedule-settled PayPal variant, ownerless Shopping in Other and a false card-minimum attribution.

## Reading the ranking

`sampledSeedCount` and `sampledObservations` rank exposures from the seeded timeline and the isolated replay of naturally generated consensus cases. An observation identifies the seed, day and control or fault. Several signatures on that exposure count once per cause. `seeds` and `observations` also include the deliberately forced cases. These counts describe the invented population. The full catalogue and the mandatory six-witness panel are coverage evidence.

For each distinct reported failure signature, delta debugging removes rows and unnecessary fixture changes, tries every remaining single deletion, and reruns the surviving case. Each witness is one-deletion minimal relative to its named seed, day, fixed opening, payroll, small control purchases and fault. `rows` contains the extra visible provider rows. `operations` identifies their economic events and selected copies. A zero-row witness can still require a damaged balance, a qualified prior reading or the explicitly identified control purchase. A smaller witness may exist under different household terms.

The label catalogue covers the pre-mortems and representative public classification shapes, with invented personal and issuer labels. A private provider catalogue can change independently. The simulator measures how the supplied evidence is handled and does not establish how often the household performs a habit or which repair the owner authorizes.
