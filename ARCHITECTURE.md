# Architecture

How this project is put together, where new material goes, and where it is
heading. `CONTEXT.md` orients a session; this explains the design.

---

## The shape: five layers, one direction

```
  raw/          SOURCE        statements, exports          immutable · local only
    ↓
  scripts/      EXTRACTION    decrypt, parse, normalise    deterministic · committed
    ↓
  derived/      INTERMEDIATE  parsed output, aggregates    disposable · local only
    ↓
  docs/         KNOWLEDGE     analysis, facts, questions   durable · committed
    ↓
  data.json     PUBLICATION   the figures the site shows   committed → deployed
```

Those five layers are the **file-evidence path**. They remain how statement
PDFs, exports, and other captured files move when that path is used. They are
not the household's normal operational refresh.

Material only ever flows **down**. Nothing edits `raw/`. Nothing hand-writes
`derived/`. A published figure traces to its evidence: a Lunch Money
observation on the normal refresh path, or a statement / institution artifact
when that file path is the source.

### Inside publication: source facts to a decision

`data.json` is not the last step. Within the published layer there is a second
one-way flow, and it exists because the alternative — every page working out its
own answer — produced a homepage that showed `$1,650/week` in one tile and `$0`
in the block underneath it.

```
  data.json              SOURCE FACTS      balances, rates, dated obligations
  public/periods.json    SPENDING HISTORY  generated; the only home for actuals
    ↓
  forecast.js  simulate()          cash, day by day
               projectDebts()      the same events, seen from the debt side
               budgetBreakdown()   essential vs discretionary vs already dated
               recommend()         THE weekly household cap
               incomeDeadline()    when a modelled income becomes required
               renewal()           the May 2027 renewal, from the same debts
    ↓
  plan.js / bills.js / subscriptions.js / credit.js / planning.js / plan-spend.js / deepdive.js / records.js / modellers.js   render only
```

**The engine decides; the pages render.** `forecast.js` is pure and DOM-free, so
`npm test` exercises exactly what the browser runs. A page that computes a
financial answer for itself is a bug — that is how the same question came to
have two answers.

Three rules follow from this, and the test suite enforces all three:

- **One fact, one home.** Historical spending lives in `periods.json` and is
  *derived* into the budget, never copied into `data.json`. `data.json` carries
  the classification, any owner override, and any explicit current-regime
  assumption — not a second copy of the historical series.
- **Every dated item declares where it would otherwise sit.** A bill or
  commitment names its `budgetCategory`, and that amount is subtracted from the
  category's average. Without it, Shaw is paid twice — once on the calendar and
  once inside a telecom average that already contains it. Undated
  current-regime (`currentMonthly`) is reserved as daily cash on
  `Forecast.simulate` and is likewise removed from the weekly-cap remainder.
  A dated card-paid bill (Bell Mobility on the 15th) is reserved on
  that planning day instead of a daily smear, and is not a second
  chequing withdrawal beside the later card payment. Either reserved
  form is removed from the weekly-cap remainder so a card-paid service
  is not counted once as reserved cash and again as cap remainder. Essential/required monthly totals and coverage still include
  that reserved amount; the cash walk tracks it on a reserved ledger total,
  not in the weekly-cap variable/Budget column. Cap comparison (room,
  shortfall, in-cap total) uses the in-cap planned remainder only.
- **Every obligation names the debt it moves.** `debtId` plus `effect`
  (`payment` or `capitalise`). Cash leaving the chequing account has to arrive
  somewhere, and the suite reconciles the two sides to the cent.
- **Household values may change without rewriting behaviour tests.** Engine
  behaviour uses synthetic fixtures and independent arithmetic; authority tests
  mutate the parent and check the child follows; live cents belong only in
  deliberately live reconciliation. A copied household figure is not a
  specification.

| Layer | Directory | Committed? | Rebuildable? |
|---|---|---|---|
| Source | `raw/` | **Never** | No — irreplaceable if lost |
| Extraction | `scripts/` | Yes | — |
| Intermediate | `derived/` | **Never** | Yes, by re-running scripts |
| Knowledge | `docs/` | Yes | No — human judgement |
| Publication | `data.json`, `public/` | Yes | Partly |

`raw/` is the only irreplaceable directory, so it is backed up separately —
`scripts/backup-raw.ps1` mirrors it into OneDrive, outside git entirely. Run it
after every capture session. Everything else can be rebuilt from it, or is in
git.

---

## The flow, end to end

**Normal operation — owner-approved 2026-08-17.** Lunch Money is the
household's **normal operational financial update feed**. The owner does not
want to maintain the same current account data twice by syncing Lunch Money
and separately downloading routine monthly statements into Atlas.

```
institutions / owner-maintained Lunch Money accounts
    ↓
Lunch Money                              evidence / update feed
    ↓
Atlas observation + reconciliation       read-only observe; non-writing compare
    ↓
canonical Atlas state                    data.json; automatic write not yet earned
    ↓
Forecast                                 sole planning / calculation authority
    ↓
Atlas website / ChatGPT / other consumers
```

Forecast remains the sole deterministic planning and financial calculation
authority. Lunch Money is an evidence/update source. It is not the planner,
not the canonical Atlas plan, not household policy, and not authority over
future commitments, priorities, or owner decisions. Where institutional
evidence directly contradicts Lunch Money and is available, the institution
is stronger factual evidence.

Routine use is:

1. Lunch Money automatically refreshes connected accounts.
2. The owner updates any manual Lunch Money accounts when they want those
   balances current.
3. Atlas reads Lunch Money.
4. Atlas reconciles new observations against canonical state.
5. Today's live plan may overlay current posted balances and pending
   onto an in-memory clone (`scripts/live-plan.js`) without rewriting
   the dated opening or snapshots. The clone's Forecast start becomes
   the observation's household financial date only when the live packet
   is freshness-qualified for that date: required spendable cash
   identities need acceptable evidence for it, and required revolving
   pending must be known/current. MATCH is not freshness; `fetchedAt`
   alone does not advance the in-memory opening.    If completeness or
   freshness is insufficient, the overlay fails closed and keeps the
   dated opening. When that later observation cannot form a trusted
   current opening, the dated sheet is not published as today's
   operating plan (`liveOverlay.operatingPlan` unavailable). Current
   spend permission, current-period action, extra-debt instruction,
   the active spending-cycle label, current money-available, paycheque
   action, next cash-out, Amanda salary has-to-land-by guidance, the
   current Consumer debt hero tile, and    the active payday waterfall
   (Payday balance as the pay-period income identity, Household Budget planned dollars /
   bills / Balance After Deductions as today's operating waterfall) are withheld. The Plan
   page then renders one compact unavailable-state experience instead of
   the current payday snapshot: dated-opening cash is not labelled
   Current Balance, and an unapplied later refresh timestamp is not
   presented as the financial as-of. Live Current Balance stays outside
   the payday snapshot when the operating plan is available. The live
   Current Balance glance uses the incumbent provider cash-observation
   date (`observedAsOf` / `evidenceDate`), never Atlas `fetchedAt`, and
   does not stamp an unapplied overlay timestamp onto dated-opening cash.
   Freshness-qualified posted cash is still attached as
   `liveOverlay.observedCash` for current chequing availability without
   rewriting that opening.    A complete trusted current-cash observation
   remains the Forecast opening when a same-day inbound is unproven or
   ambiguous: that inbound is not added on top of posted cash and is not
   labelled represented (`plan.opening.notReliedUponEvents`). A later
   same-date refresh rebuilds those guards independently of a prior hold
   and retains the hold until applicable posting proof resolves it.
   Incomplete or untrusted current cash still fails closed. Same-day unposted
   joint-cash bills stay still due and do not fail the overlay. Owner
   policy 2026-09-11: Forecast may still mark Dale's Seaspan payday
   salary relied-upon for planning from 00:00 PT that household date
   without inventing a deposit or calling it represented; Amanda salary
   stays unconfirmed until settlement evidence. A future
   confirmed salary before its payday remains ordinary Forecast income,
   subject to the posted-income reconciliation gate in the incumbent table.
   Scheduled joint-cash occurrences in `(historicalOpeningAsOf, liveAsOf]`
   are accounted for before as-of advances: represented names go on the
   in-memory opening, and unrepresented joint-cash outflows stay reserved
   through `plan.opening.priorAsOf`. Forecast still calculates. Explicit
   `ATLAS_LIVE_OVERLAY=fixture|live` enables that clone on
   `/data.json`. Production is configured for `live` with owner-supplied
   Render secrets; without those secrets, or if live evidence cannot be
   trusted, the dated opening is served fail-closed. Unattended
   production writes remain **not** authorised.
6. A new canonical opening still flows through the earned Atlas refresh
   / canonical-update mechanism (`scripts/canonical-refresh.js`): observe →
   reconcile → preview → explicit owner approval → bounded `data.json`
   write. Default is still a non-writing preview. Unattended production
   writes remain **not** authorised. A production Lunch Money token is
   authorised for on-demand GET-only observation (2026-08-23) and, as of
   2026-09-04, for the two Lunch Money `category_id` grants recorded on
   the
   [`docs/connectivity/PRODUCTION_LIVE_READONLY_OWNER_PASS_2026-08-23.md`](docs/connectivity/PRODUCTION_LIVE_READONLY_OWNER_PASS_2026-08-23.md)
   addenda: the exhausted one-transaction correction, and the later
   reusable Household Budget → Other Spending class. Neither grant makes
   the token a general Lunch Money write credential or a canonical Atlas
   write path.
7. Forecast recalculates from the live overlay or the dated opening.
8. Atlas exposes the freshness and uncertainty that remain.

Some household accounts or cards are not automatically refreshed by Lunch
Money and require the owner to update current balances there. That is
**accepted owner policy**. Do not require a duplicate Atlas statement-import
workflow merely because those accounts are manual in Lunch Money. Atlas
consumes the state Lunch Money reports while preserving truthful freshness /
observation metadata. If a manually maintained Lunch Money account is stale:
do not pretend it is institution-live; do not manufacture a newer balance;
do not block all other current-state refresh because that one account is
older; preserve and report its actual observed or provider-updated freshness
where available. Accuracy of that account's contribution to the outlook
depends on the owner's Lunch Money update. Do not invent a generic count of
manual accounts. Triangle and MBNA are the owner-named monthly
statement-maintained exceptions; their evidence cadence lives in
[`docs/ACCOUNT_FACTS.md`](docs/ACCOUNT_FACTS.md) and is keyed by canonical
Atlas identity. Cadence may accept current-cycle statement evidence. It
never rewrites `evidenceDate`. Cash Back and the other live TD accounts
keep exact-day freshness.

Owner-only information still enters Atlas separately when Lunch Money cannot
know it: future commitments, planned purchases and travel, household policy,
priorities, cancellation or settlement knowledge, unknown account purpose,
contractual facts Lunch Money does not supply, and exceptional corrections.
That is not duplicate balance maintenance.

**The file path remains for manual, historical, and fallback evidence.**
Historical and manual statement files are useful for backfill, dispute and
verification, contractual terms Lunch Money does not expose, direct
institutional evidence when a provider value conflicts, and unusual evidence
collection. They are **not** the routine monthly operational refresh
requirement. Proven statement extraction tooling is not deleted and is not
declared useless. It is not the operational prerequisite for Atlas freshness.

When a statement file is the source:

1. **Drop it in `raw/`.** Never edit it. Never rename it beyond a clear
   convention: `raw/statements-<institution>/<YYYY-MM-DD>-<account>.pdf`
2. **Extract.** Use an existing script if one fits; write one in `scripts/` if
   not. Statements are encrypted — see `docs/ACCOUNT_FACTS.md` for which scheme
   each issuer uses.
3. **Write intermediate output to `derived/`.** Never to `docs/`.
4. **Update knowledge** — `docs/ACCOUNT_FACTS.md` for new standing facts,
   `docs/positions.csv` for the account row, `docs/01_OPEN_QUESTIONS.md` for
   anything raised or answered.
5. **Update `data.json`** with figures that belong on the site.
6. **Commit and push.** Render deploys within a couple of minutes.

The pre-commit hook refuses file-path steps 1 and 3 from reaching git,
whatever else goes wrong. GitHub API commits are judged by the same engine
from the trusted default branch (`scripts/privacy-guard.js`).

---

## Where things go

**One fact, one home.** The most common failure mode in a project like this is
the same number living in three files and drifting.

| Kind of thing | Home | Not |
|---|---|---|
| Rates, limits, due dates, renewal dates | `docs/ACCOUNT_FACTS.md` | anywhere else |
| Balances, available credit | `docs/positions.csv` and `data.json` | `ACCOUNT_FACTS.md`. `positions.csv` is the account-row snapshot, **not** a universal fact database |
| **Work still to do** | **`BACKLOG.md`** | a chat message |
| **Things only a human can answer** | **`docs/01_OPEN_QUESTIONS.md`** | `BACKLOG.md` |
| Narrative analysis | `docs/00_MASTER_PICTURE.md` | `data.json` |
| Per-account depth | `docs/*_DEEP_DIVE.md` | the master picture |
| **What one person said, attributed and dated** | **`docs/household_interviews/`** | `data.json`, a budget target, or joint policy |
| What the site displays | `data.json` | hardcoded in `public/` |

**Backlog versus questions.** A backlog item needs someone to *do* something and
can be closed by doing it. A question needs someone to *know* something and can
only be closed by an answer. Mixing them produces a list where nothing is
actionable because everything looks blocked.

**Facts and figures are kept apart deliberately.** A rate is stable; a balance is
not. Mixing them lets a stale balance masquerade as a standing fact.

**An interview is one person's evidence, not the household's decision.** It keeps
the estimate, target, conditional and unresolved labels the speaker gave it, and
promoting any of them to a verified figure or a shared target is a separate step —
owner-reserved, because it changes how a figure is tagged.
`docs/household_interviews/README.md` holds the rules for that folder; this file
records only that the folder is where such evidence lives.

### Adding a new account

1. Row in `docs/positions.csv` — set `entity` to Household or Business
2. Section in `docs/ACCOUNT_FACTS.md` with a **verified** date
3. Entry in `data.json` under `debts`, plus `revolvingExtra` if it is an overdraft rather than a debt
4. Derived publication totals follow from those rows via `Forecast.publicationTotals` — do not store a matching headline, net-worth total, or second HELOC limit
5. Any new questions into `docs/01_OPEN_QUESTIONS.md`

---

## Principles

These have governed the work so far and should continue to.

**Tag every figure.** Verified from the institution / calculated / estimated /
unknown. An estimate is never presented as a verified fact. This is what makes
the analysis trustworthy rather than merely confident.

**Verify rather than assume.** Where a model can be checked against the
institution's own numbers, check it. The mortgage amortisation model was trusted
only because it reproduced TD's stated remaining term to within a month.

**Cross-check across sources.** PayPal's spending total was wrong until it was
checked against the bank-funding pulls. Two independent paths to the same number
is the cheapest error detection available.

**Corrections are folded in, not appended.** When something is found to be
wrong, the document is rewritten to be right, with a short note of what changed.
Readers should see the current position, not a history of the reasoning.

**State coverage honestly.** Say what was captured, what was not, and what could
not be categorised. `docs/00_MASTER_PICTURE.md` carries a coverage section for
exactly this reason.

**Read-only against institutions. Never handle an institution login credential.**
No transfers, payments, applications, setting changes, form submissions or
agreement acceptances. Passwords, PINs, security codes and 2FA are the owner's
alone. *(The application's own server-side secrets are a different thing — see
**The secret boundary** below, which is the one home for that line.)*

---

## Direction

**This file is the one home for direction.** It owns what Atlas is for, what is
in bounds, which authority owns which concept, and the gate each future
capability has to pass. Where any other document disagrees with this one about
direction, this file wins and the other is wrong.

*Sequencing* — the order work is done in, and the prompt for each piece — is a
different question and does not live here. `docs/ATLAS_FINANCIAL_BUILD_STRATEGY.md`
now owns that sequencing, and it may schedule only what this file already permits.
Nothing in the strategy can pass a gate or override direction recorded here.

### The destination — owner-approved

Atlas is being built toward a **household financial operating system**: deeply
understood spending, unknown transactions burned down, Dale's and Amanda's input
reconciled, realistic budgets, a weekly safe-to-spend figure, upcoming
obligations and a financial calendar, planned purchases, deterministic horizons
and scenarios, debt and cash guidance, fresh data when it is earned, and an
assistant-neutral way to ask about all of it.

That destination is approved. **None of it authorises a technology.** Each gated
capability below still has to pass its own gate, and a gate is passed by evidence
and an owner decision — never by a plan reaching that line.

The tiers below describe **the stage each capability is at**, not a ceiling — and
not a record of current progress, which is `BACKLOG.md`'s.

### One plan, many windows — owner-approved 2026-08-12, refined 2026-08-16

Atlas maintains **one master household financial forecast**, and every horizon
is a window onto it. That forecast is the dated projection Forecast produces
from `data.json` `plan` and the opening cash and debt facts. Its knowledge
horizon is **at least twelve months** from the opening as-of.

The live Plan page still *displays* a 91-day window (`plan.windowDays`). That
display is a view, not the plan's knowledge bound. `Forecast.recommend`
searches the knowledge horizon; the weekly figure on screen is from that
master walk, not from the visible range alone. The default Plan first screen
is the payday operating sheet: Forecast `paydayAllocation.liveCurrentBalance`
is Current Balance for canonical `chequing-a` / BILLS ACCOUNT only.
Normally that figure is trustworthy posted hub cash
(`Forecast` `postedBillsAccountCash`). On a scheduled Dale/Seaspan payday,
from the America/Vancouver financial-day rollover until provider evidence
represents that payroll, Forecast temporarily publishes a trustworthy
immediately pre-payday BILLS balance plus that scheduled payroll. A
same-day refreshed BILLS balance is not that base and is not increased by
the planned payroll while representation lags; if the pre-payday balance
cannot be proved, Current Balance fails closed. On a live refresh,
`scripts/live-plan.js` retains that proof in memory as
`plan.opening.prePaydayBillsBase` by calling `Forecast.prePaydayBillsAccountCash`
on the pre-overlay plan before the same-day BILLS row is replaced.
Incomplete coverage of any gap day stores nothing. That retain is not a
canonical write and not a new cash store. Forecast then classifies posted chequing-a movements dated that payday
with `Forecast.postedAccountMovements`. Outflows are ordinary. An inflow
is an ordinary credit only when it is positively labelled non-income: a
proven household-internal transfer already stamped on that movement
(`internalTransfer`, classification `internal-transfer`, and a known
household-cash counterpart), or an explicit refund category
(`REFUND_LABELS` on the transaction `categoryLabel`) that is outside 1%
of the planned payroll. A refund category inside that window fails
closed: the label is not proof the credit is not the deposit, and
counting it would add planned payroll again. A proven household transfer
inside that window stays an ordinary credit, because the pair is another
household cash account and not an external payroll deposit. The amount-sign
refund shortcut is not that label. Otherwise exactly one inflow within
1% of the planned payroll, and not positively labelled non-income, is a
plausible unrecognised Dale deposit: it is excluded and the planned
payroll is added once. Any other same-day inflow fails closed, including
an off-plan deposit, a split deposit, an unlabelled credit, more than
one plausible deposit, or a missing transaction. A retained pre-payday
base with no transaction packet fails closed. A payday movement packet
that is present but incomplete fails closed. Seaspan merchant text is
not an identity. The refreshed BILLS row is never that base and is never
increased by the planned payroll. The assumed amount is labelled
planned and unconfirmed, and the observed hub balance replaces it without
adding the salary again. Other income streams are not pre-posted. Chequing B / WEEKLY SPENDING, designated savings, Travel Visa,
and every other account stay out of that headline. Missing or untrusted
hub evidence fails closed; Forecast does not substitute Weekly, pooled
A+B, or `startingCash.amount`. The Budget page prints that same Forecast
Current Balance. Unused overdraft capacity still never enters. Forecast
walk and paydayAllocation spendable opening (`startingCashAmount`) still
uses the chequing-only pool (A+B). Designated
`savings` / EMERGENCY SAVING stays on the breakdown as reserve evidence and
is not ordinary spendable opening. Current Balance is not savings, not
TENNIS INCOME, not overdraft, and not Weekly. It is not ordinary same-day
arriving income. The Dale/Seaspan payday assumption above is the only
midnight cash exception, and it is printed outside the payday
snapshot. The frozen payday opening is a recorded `paydaySnapshot`, payday-morning cash, the non-live dated opening when that opening's as-of is this Forecast start, or `Forecast.establishPaydaySnapshot` from a completeness-proven household-cash walk of that dated opening on the chequing-only spendable pool — designated `savings` / EMERGENCY SAVING movements in the gap stay reserve evidence and do not change that reconstructed opening — never today's live cash, and never a scheduled-only reconstruction that assumes unscheduled gap spending was zero. For that reconstruction alone, optional `plan.opening.cashReconstructionAnchor` may supply a separately owner-approved complete A+B bank end-of-household-day basis on the same original date. Forecast requires the bank source, explicit EOD boundary, household timezone, CAD, owner approval reference, and one cent-exact known balance with statement reference per operating account. An explicit invalid anchor holds; absent evidence keeps incumbent behavior. The original observation and historical snapshot remain intact; a valid frozen payday snapshot keeps precedence. Anchor-day movements are already included, so the complete walk starts the following day. EOD is never the morning of its own date, current cash, or permission to move money. No real anchor is activated by this code-support contract. Payday balance is Dale salary + Amanda salary + recognized Other Income, not that frozen opening plus assigned income and not today's live cash plus remaining paycheques,
bills this pay period from this payday through this period
with paid still listed. Paid and remaining are settlement disclosure;
the Bills waterfall step subtracts the authoritative period bill load
assigned against this pay period, including subsequently
PAID rows that are not already inside that opening. A PAID status does
not put that bill's cash back into Payday balance. Owner 2026-09-21
supersedes the pooled-household Predicted Ending Balance interpretation
for the household-facing current-pay-period surface: Balance After
Deductions is the planning remainder
`displayed period income − assigned bills − Household Budget hold`.
Displayed Income / Payday balance (`incomeTotal` / `period.available`)
is the income term, including not-relied-upon period income. Lunch Money
signed credits are not subtracted as negative income. Those three terms
are published on `predictedEndingBalanceTerms` with identity
`balance-after-deductions` and must arithmetically close; there is no
balancing plug. Current Balance is not a term in that remainder. The
payday-boundary opening (posted Chequing A plus Chequing B, including a
negative Weekly carry) remains the cash opening used for next-period
carry and diagnostics; it is not added into Balance After Deductions.
It is not chequing-a posted-balance-observed-on-household-date, not a
transfer-history total, and not today's live Current Balance. Balance
After Deductions does not fail closed merely because that payday-boundary
opening is unknown. A mid-period dated opening is not Current Balance.
Balance After Deductions is not posted hub cash and not
`paydayAllocation.runningLeftover`. Money moved to Savings remains
household money; location is explanation, not consumption. Household
budget owner-target lines still use Σ max(planned, actual) plus Other
Spending actual. Cross-account eligible spending (Weekly, Travel Visa,
other household cards) still feeds that hold; hub → Weekly / Savings
transfers are location, not expense; a card payment does not duplicate
underlying card spend. Extra on the highest-rate revolving card, other
revolving cards, and big purchases may follow Balance After Deductions
on the current-period sheet; they do not feed it as next-period cash.
`paydayAllocation.runningLeftover` remains the current-cash
allocation chain (what current cash must do) and is published by
`Forecast.recommend.defaultView` / `paydayAllocation.runningLeftover`.

The same result also publishes `nextPeriodView` (the next Seaspan payday
period from `Forecast.spendingCycle`, Current Balance from the already-run walk's start-of-day cash plus
that payday's income), `weekViews` (one 10-block view per simulated week,
opening from that week's walk, leftover from that week's unpaid bills and a
7-day owner-target hold — not a second weekly leftover engine), and
`pastPeriodViews` (completed Seaspan payday cycles behind the current
operating window; dates from `Forecast.spendingCycle`; payday carryover is
known payday-boundary cash carried into the next period, counted once, not
income; received/PAID rows require independent historical settlement or an
observed actual, otherwise they render as planned/unknown; `householdBudget`
publishes classified Spent actuals when the actuals packet covers that
window), and `paydayCarryoverTrend` (chronological projection of those
completed-period Payday carryover fields, oldest payday first; known amounts
are copied including the sign, unknown stays unknown, a genuine $0 stays $0, and nothing is
interpolated, estimated, or classified as income, savings, or extra money).
The same result also publishes `payPeriodViews` and `payPeriodTimeline`.
`payPeriodViews` is one chronological sequence of incumbent Budget
pay-period rows: `pastPeriodViews` oldest first, then the current and
next `defaultView.calendarPeriods` rows, then further full Seaspan
cycles. The past, current, and next entries are those same objects.
Each row adds only `timelineRole` (`past`, `current`, `next`, or
`future`), `timelineOffset`, and `evidenceState` (`historical`, `live`,
or `projected`). Further future rows are the same
`calendarPeriodWaterfalls` printer, id `future:<start>`, role `future`,
chained by `Forecast.spendingCycle`. A further cycle is included only
when it is complete and its end is on or before `payPeriodTimeline.through`.
`through` is the earlier of the knowledge-horizon end and the 2027
estimated-regime end. Owner Dale, 2026-09-25 7:43 PM PT: "Use the 2027
estimated payroll for 2027 pay periods, marked as estimated."
`Forecast.projectedDalePayroll` is the one projected Dale payroll source.
It reads `plan.payrollPlanningAssumptions` through
`Forecast.daleEstimatedPayrollDeposits` and does not add a second
statutory calculator. The Road Ahead walk and Budget timeline rows
both consume that source. The estimate is applied on future, next, and
current rows for Dale payroll dates from 2027-01-01, marked estimated
(`incomeRegime` `2027-estimated`), until an observed deposit or a
represented key for that occurrence supersedes it. A date-passed
`received` / `alreadyInCash` presentation does not, including when the
calendar printer stamps `settlement` `opening` only because a recurring
date is before the cash snapshot. That stamp is not an observed amount.
The actual amount then wins once. It is not applied
to past rows, 2026 dates, or `nextPeriodView`. When
`plan.payrollPlanningAssumptions` are absent, current and next keep
the incumbent amount and further 2027 cycles are omitted. The 2026
modelled net is not carried into an unevidenced 2027 row. A 2027 row's
Dale income can shift when an actual deposit for that occurrence posts.
`incomeRegimeBoundary` stays 2026-12-31. `horizonReason` names the
binding boundary. When the regime is unavailable the timeline still
stops at 2026-12-31. The timeline does not read Road Ahead stage
results, cumulative trajectory cash, or month-close surplus. When fewer
than eight further cycles fit before `through`, the reason states that
the owner minimum (the next pay period plus eight further future
periods) is not met inside that through date.
`defaultView.calendarPeriods` stays the two incumbent rows, so Budget's
This / Next / Show both print is unchanged. `nextPeriodView` stays the
More views lookahead ten-block and is not a timeline authority. The
timeline next row is Budget's Next Pay Period (`calendarPeriods` id
`next-pay-period`). The timeline does not read Road Ahead stage results,
cumulative trajectory cash, or month-close surplus, and it does not sum
per-row extra-debt or big-purchase allocations. On a row past the
incumbent next period, the printer opening is labelled projected period
cash. It is not Current Balance and it is not a Balance After Deductions
term. `liveCurrentBalance` stays null off the current row. On a role-`future`
window — Budget's Next Pay Period and every further timeline row — an
occurrence dated after the Forecast financial date keeps its amount in
that period and in `periodBillLoad` / Balance After Deductions, and its
household-facing status stays planned. It is not labelled PAID.
`paidBills` and `remainingBills` follow the same date rule: the
occurrence is not yet paid, so Paid bills this period excludes it and
Remaining bills to pay includes its amount. Its settlement is not
`represented`. A represented key dated on or before that financial date,
and every past or current row, keeps the incumbent status. Because the
next timeline row is the same object as `calendarPeriods` id
`next-pay-period`, Paid bills this period and Remaining bills to pay can
change on Budget's Next Pay Period. The bill amount, `periodBillLoad`,
and Balance After Deductions do not change from that bill-status rule.
Owner 2026-10-04: Other spending has an explicit $450 target every pay
period, starting with Sep 25-Oct 8, 2026. The canonical `other-spend`
category carries `plannedPayday: 450` and `targetEffectiveFrom:
2026-09-25`. Forecast's `calendarHouseholdBudget` publishes that target
for eligible current and future cycles, once. Eligible observed Other
membership remains the incumbent reconciliation: under target holds 450,
over target holds the actual once, and the unused target remains reserved.
This is an owner planning target, not a bank transaction or confirmation
of unclassified purchases. A missing actual stays unavailable; it does not
become zero or 450 left. Future rows and their holds retain estimated
trust. Completed periods use observed consumption as the historical hold;
their current configured target is not an original historical plan snapshot.
Cycles beginning before Sep 25 retain their original current/historical
actual-only Other behavior. The old $800 monthly and $400 future-only
policies are bounded retired `targetHistory`, never co-active targets.
Road Ahead, `budgetBreakdown`, the weekly cap and generated positions use
the incumbent owner-target conversion from the active per-payday target.
`public/plan.js` prints the selected view only. Diagnostics stay folded.

**Named ranges are views of that same forecast.** Week, payday, month, 13 weeks,
6 months, 1 year, and a custom date range are different spans of the same dated
projection, from the same starting facts. A custom range may start after the
opening as-of; that is still a slice of the master walk, not a second forecast.
They are not separate engines and not separate answers. A payday plan is Forecast
output shown for a payday span; it is not a second payday planner.

**Changing the visible range never changes what the plan knows.** Shortening the
window does not drop a later commitment from the forecast, from safe-to-spend,
or from the funding sequence. Changing an input recalculates every affected
view from that one plan, so a short-horizon answer cannot quietly contradict a
long-horizon one.

**The deterministic engine stays where financial decisions are made.** Forecast
is the planner and the calculation authority. That is the rule at the top of
this file applied to the destination, not replaced by it. A page, ChatGPT, a
Google Sheet, or a later helper may not stand up a second planner, a generic
planning schema, or a parallel authority. The capabilities below are earned by
**evolving Forecast in place**. Until a capability is earned it is not an
incumbent-table row, and the absence of a row is not a licence to invent an
owner beside Forecast.

**Two consumers plus one execution tracker, one answer.**

| Surface | What it is for |
|---|---|
| The website | visual presentation and inspection of the plan. The household Talk page consumes the same sanitized assistant packet via session-only `GET /talk/context`. That packet may include the owner-stated `plan.decisionPosture` labels so Talk can explain household decision policy without planning. Session-only `POST /talk/ask` sends that packet plus the household question to Google Gemini (`gemini-2.5-flash-lite`) so Talk can explain incumbent Atlas state. An ephemeral in-memory turn buffer keyed to the authenticated session may hold conversational context for follow-ups inside that session; history is not household-financial evidence, not Forecast state, not owner policy, and not a write. Follow-up amounts and named debts are resolved only under that explicit contract; ambiguity is unavailable. Campaign-style verified follow-ups resolve only against ephemeral structured refs from a prior verified presentation and re-read this request's packet or recompute Forecast; conversation prose is not a figure source. Talk may reprint Forecast-owned `paydayAllocation` leftover stages and leftover-consuming allocated amounts for “what does this payday look like?”, and `paydayAllocation.runningLeftover` for “what does this payday leave us with?” and for an unambiguous leftover “what does that leave us with?” earned from a verified payday leftover or payday look-like presentation. Talk may reprint Forecast-owned `currentPeriodAction.bills` for which household bills remain before the next payday. Settlement is Forecast-owned (represented / upcoming / unverified). Talk does not date-filter that list, invent a paid list, reconstruct settlement, or treat unverified as unpaid. Gemini extracts leftover, payday-picture, or remaining-bills intent or referent only and cannot manufacture or modify those amounts or settlements. Unavailable leftover is not $0. Unavailable remaining bills are not none. Talk does not reconstruct a leftover stage by subtracting. Gemini is an explainer, not a planner, and must not invent answers. The server never publishes free-form model text: it accepts only a structured extractive claim list, verifies each claim against this request's packet, and maps those verified packet values through deterministic Atlas presentation templates (human labels, currency, provenance, trust, and at most one existing-route link). Household-facing citations are assembled by the server from those same allowlisted Forecast/Bills/Credit/Planning sources and existing Atlas routes; Gemini cannot invent citations, source paths, URLs, Forecast provenance, or trust labels. Talk may explain an already-published Atlas or Forecast result through a deterministic why-trace: Gemini may extract only why-intent plus an optional allowlisted referentPath or referentKey; the server assembles the explanation from existing packet fields and provenance templates. Gemini must not invent causes, numbers, or policy. A why-ask without a publishable referent is unavailable. When the browser asks for `text/event-stream` on that same POST, the server may emit allowlisted progress phase ids (`understanding`, `checking-atlas-context`, `running-forecast`, `preparing-verified-answer`) and then the same verified JSON body as a final `result` event. Gemini tokens, incomplete model JSON, and unverified prose are never streamed. There is no resume of a partial answer. The household Talk page may organize that already-trusted presentation into structured answer cards; missing or malformed card data fails closed to the plain answer bubble. Cards reprint server presentation strings and do not calculate figures or invent financial meaning. Unknown paths stay conservative path-is-value wording and do not invent meaning or Forecast provenance. The instruction prompt is not the Forecast-authority control. The browser never holds `ATLAS_TALK_GEMINI_API_KEY`. `Forecast.hypotheticalExtraPayment` is the read-only Forecast what-if extra-payment boundary. Talk may extract only an explicit caller amount plus named debt, or two or more explicit amount-plus-named-debt pairs for a comparison, resolve each label to one stable eligible id, and present Forecast-computed consequences. When the caller asks preference over an already-earned explicit two-option A-vs-B, Talk applies the owner preference rule to those Forecast comparison figures only and presents PREFER or NOT YET / INDETERMINATE. After exactly one such earned A-vs-B in the current Talk session, a bare “Which one?” refers to those exact two options and invokes only that same owner preference contract. Session uniqueness is a compact ephemeral comparison-identity signal keyed to the auth session; it survives 8-turn eviction and is not household-financial evidence. Multiple comparisons, 3+ options, stale or unearned priors, or leftover / bills / hypothetical last turns fail closed. Preference judgment is exactly two scenarios; a 3+ option preference ask is NOT YET / INDETERMINATE and does not emit PREFER. Forecast comparison of two or more extras is unchanged. Gemini may resolve that Which one? referent only and does not calculate them, choose an amount or target, pick a winner, or recommend an action. Missing amount or target, swapped pairings, and unauthorized planner-act asks, stay unavailable. |
| ChatGPT | conversational query and explanation interface. It consumes the incumbent `GET /assistant/current` packet through the OAuth-protected, read-only MCP resource `POST /assistant/mcp`. It is not a planner. |
| Google Sheet | execution tracking of a plan Forecast already produced |

None of them may create a second financial answer, and none is an authority.
They consume the same ones. A surface that works a figure out for itself is the
defect `B73` exists to close, arriving through a new door. The **normal**
refresh chain is Lunch Money → observation + reconciliation → canonical Atlas
state → Forecast → those three surfaces. `B91` is done. Lunch Money is the
evidence/update feed, not a second planner. Owner-approved preview/apply
writes, the published 2026-08-19 canonical opening, and the read-only
live overlay are earned (`B81` / `AF-LIVE-02`). A production Lunch Money
token is authorized for on-demand GET-only observation (2026-08-23) and,
as of 2026-09-04, for the two `category_id` grants recorded on that
production pass: the exhausted one-transaction correction, and the later
reusable Household Budget → Other Spending class. Neither grant is a
general Lunch Money write credential. Unattended production writes and
a newer live substitute opening remain owner-reserved. Those reservations are not a missing B81
implementation slice.

**What the plan is expected to cover, as each capability is earned:** material
income and compensation, debts, bills, spending and budget, known dated
commitments, sinking funds, planned purchases and travel, and assets, pension
and investments — together with the scenario inputs that vary them. Naming them
here authorises none of them; each still passes its own gate below.

**Safe-to-spend is constrained by the future the plan knows, not by today's
balance and not by the visible range.** `Forecast.recommend` remains the weekly
household cap. Known major costs, required debt payments and the buffer policy
hold back today's figure even when they fall outside the span on screen. That
function, not a second cap, searches `Forecast.knowledgeHorizon`. An estimate
still cannot be presented as verified.

**Forecast preserves simultaneous feasibility among protected commitments.**
Protected future commitments — dated cash events, dated ranges that keep
their deadline without collapsing to a midpoint, and undated known needs —
must remain jointly feasible before any residual is accelerated. A dated
range stays encumbered from the point it is funded or due until settlement
or authorized release; optional residual is after that still-encumbered
principal. That is not a serial leftover queue. Owner-stated priority ranks
only what is left after harder constraints are met, and among optional
items it wins over date. `adjustable` is bounded-flex, not
optional; required / bounded-flex / optional is derived from owner-stated
fields and is never invented onto a live row. When a commitment is fully
funded, paid, deferred, reduced, or otherwise releases contribution
capacity, Forecast reallocates that freed capacity across the remaining
plan. Encumbered principal is not free cash: completion releases future
contribution capacity, not the earmarked principal itself. Freed capacity
does not automatically become safe-to-spend. This is not a goals engine
and not a generic priority schema. `Forecast.fundingSequence` is the
presentation order; `Forecast.recommend` sets the weekly cap as the
maximum current discretionary outflow that leaves the protected master
plan feasible without unapproved borrowing. The owner-stated 2026-08-24
true-surplus debt policy is recorded in `plan.nextDollar`; Forecast applies
it only after those protections hold.

**Planned debt is allowed when it is the better household plan, not only
when cash is short.** Intentional borrowing may be part of the planned path
when preserving cash for higher-priority needs is better than paying a
commitment from cash in time. A cash shortfall that cannot cover a
commitment in time remains one valid reason, not the only one. When the
plan includes borrowing, Forecast must project the borrowing, the
consequences — interest, headroom, limit-crossing, later cash — and a
repayment path on the same coupled cash-and-debt walk, in advance.
Unforecast borrowing is not a plan. Debt is deterministic and
owner-constrained; it is never automatic. This does not create a second
debt modeller; `Forecast.projectDebts` and `Forecast.recommend` remain the
walk. It does not authorise an automated action against an account.

**Major future plans show ON TRACK / AT RISK / FUNDING GAP.** A named major
future plan the household is funding — travel, a sports season, the May 2027
renewal, a large purchase — publishes exactly one of those three verdicts from
Forecast, with a dollar funding margin or gap. ON TRACK means the
authoritative/base case is jointly feasible. AT RISK is only an explicitly
represented protected uncertainty case (a range ceiling) failing while the
base case remains feasible. Authoritative infeasibility is a FUNDING GAP;
cutting remaining discretionary is not the AT RISK test. Amount ranges stay
ranges: no midpoint or lower-bound point may masquerade as the requirement.
Pages render the verdict; they do not invent it. This is not a goals
product and not a fifth published-figure trust label. The four-label contract
for a published figure — verified / calculated / estimated / unknown — is
unchanged.

**A scenario changes an input to this plan.** It is not a disconnected
calculator, and its answer is compared against the same baseline the plan
publishes.

**Provenance survives into the plan.** Whether an input or a result is verified,
calculated, owner-stated, estimated or unknown travels with it, so a polished
surface cannot make a provisional assumption look settled. This does not touch
the four-label contract for a **published** figure — verified / calculated /
estimated / unknown, under **Principles** above — which stays owner-reserved.

The evidence behind this — which bills and payroll documents to collect, what is
currently unknown, and what would close each gap — is source intake rather than
direction, and lives in [`docs/MASTER_PLAN_REQUIREMENTS.md`](docs/MASTER_PLAN_REQUIREMENTS.md).
That file records what a document establishes and states no direction of its own;
what a person *said* stays attributed and dated in `docs/household_interviews/`,
per the table above.

### Tier 1 — complete the picture *(in progress)*

The analysis is only as good as its coverage. **Which gaps are still open is
`BACKLOG.md`'s to say**, and `docs/01_OPEN_QUESTIONS.md`'s for anything only the
household can answer. This file names the tier; it does not carry its contents.

That is not tidying. The list that stood here called MBNA and Affirm/Flexiti the
last debts with unknown terms and said net worth was unstateable without a home
valuation — while `BACKLOG.md` recorded capture as complete, Flexiti closed, the
home valued at $1.1m–$1.4m and net worth at $357k–$657k. It also promised four
gaps and listed three. A second copy of another document's work state drifts, and
this one already had.

### Tier 2 — cadence and trend *(the obvious next step)*

**Spending, interest and fees already have history** — `public/periods.json`
feeds a monthly trend on the Deep Dive, and `B65` records the period selector as
done. **Account balances now have dated openings** — `snapshots/<YYYY-MM-DD>.json`
is a by-product of a successful refresh. Each file is a same-date financial-state
subset (account identity, side, currency, posted balance, pending when known),
not a copy of `data.json` policy. `data.json` remains the current-state
authority. The Plan page reads those openings and prints display deltas. A
second independently reconciled opening is required before a trend is claimed;
unknown stays unknown. The recorded cash aggregate retains each snapshot's dated account membership,
including any reserve accounts; it is not current Forecast spendable cash.
The page names the included accounts and never rewrites that historical scope.
The 18-month `helocHistory` series on Deep Dive is a separate monthly chart of historical observations inside current-state
`data.json` and is not this mechanism. The current HELOC opening on that
chart is composed from `debts.heloc`; it is not a second stored copy of
today's balance.

The distinction matters because the loose version of this sentence said the whole
site was a single point in time, which would send later work to rebuild a
spending trend that already ships.

### Tier 3 — an interaction layer *(gated, not yet earned)*

If the site should ever be something the household **writes to** — ticking off
questions, logging a payment, leaving notes — that is one of the two things that
can earn a store. **That trigger has not been reached.**

---

## Authority - what owns what

### Confirmed savings purpose - owner decision 2026-10-02

Dale approved the recommended convention at 19:50:24 UTC, source
`Sentinel_7f3848e77f788191868e831be6be4270`: "Yes what ever you recommended".
The recommendation asked to retain confirmed allocations through refreshes,
leave new deposits unallocated, use that residual first for unspecified
withdrawals, and flag a shortfall rather than silently take money from a goal.
It also asked to store those confirmed assignments in this private repository.
This authorizes the optional `plan.savingsEarmarks` purpose block and the
existing owner-authorized input-update / PR path. It grants no in-app writer,
new store, bank action, provider write, authentication or signing boundary.

At that approval, the two account identities and starting goal allocations were
**not supplied**. Examples in that conversation are illustrations, not household
inputs. Synthetic fixtures prove the optional path; absent configuration
publishes setup unknown.

**Current owner role selection, 2026-10-03 03:16:39 UTC.** Dale changed the
requested purposes: DEFICIT PLANNING (ending 3074) is for Fusion and related
sports costs; SAVINGS-DONT TOUCH (ending 8420) is for property tax and home
insurance. These are two purpose-based planned-cost pools, with individual
goal earmarks, despite the first account's display name. This supersedes the
earlier proposed generic shortfall role. The decision desk inspected the
owner-supplied TD screenshot and confirmed those labels and suffixes; it does
not prove the provider mapping or supply a funding baseline.

Dale's earlier "ok configure" at 02:56:30 UTC followed disclosure that 8420
was legacy staging requiring reconciliation. The current role selection
retains authorization for a deliberate reviewed reconciliation; it does not
establish funded amounts or a new opening.

**Identity resolved by read-only provider evidence, 2026-10-03.** The existing
private provider mapping for EMERGENCY SAVING / `cash:savings` links to the live
catalog account whose mask is 3074. The live SAVINGS-DONT TOUCH mask is 8420,
consistent with `docs/ACCOUNT_FACTS.md` and `docs/reconciliation/balance-map.json`.
No screenshot balance was consumed. Real provider IDs remain in the private map.

`plan.savingsEarmarks` now configures these exact canonical identities as
`purpose-reserve`, with existing goal references separate from confirmation
history. Ending 8420 stays in held-elsewhere evidence with its dated amount
unchanged, but its canonical class is explicitly reconciled to purpose reserve.
The validator accepts this known identity only with that classification and an
explicit `reconciledOn`; aliases, duplicate opening rows and other excluded
accounts remain rejected. Both provider mappings must be `household-reserve`.
The gitignored local map is prepared; deployment must install the same two
identity-only changes in its existing private map before activating this head.
No other provider roles are changed. The legacy map is not an implicit migration.

Forecast excludes both pools from spendable cash and publishes their inventory
as a non-additive view. The old generic `savings` deficit backing is unavailable
for a purpose reserve even when current cash is observed: sports and home funds
cannot silently finance generic shortfalls. Existing configurations without the
new purpose role preserve their incumbent behavior.

Dale explicitly rejected screenshot balances as setup inputs. He will move
funds himself after amounts are chosen and then confirm the new baseline.
Starting assignments and that baseline remain **unset**, not zero funded;
neither an empty confirmed allocation snapshot nor a dated balance is inferred.
Fusion and other existing sports requirements can use commitment or group
references; home insurance can use the existing yearly `square-one` bill.
Property tax remains the incumbent `plan.budget.categories` row `propertytax`
(class `reserve`). A `budget-reserve` earmark reference consumes its
`plannedAmount` and confidence without creating a duplicate commitment,
amount, date or cash event. This kind resolves only one reserve category with
no competing commitment or bill id; missing or ambiguous identity withholds
backing while retaining intent. A planning date does not prove settlement or
release intent. The two-pool inventory itself does not require a
shortfall role. Goal requirements keep their existing Plan homes. Forecast
remains the sole
planner; role selection authorizes no automatic allocator broadening, transfer,
Lunch Money transaction write or future proposal that assumes funding exists.

Forecast owns observed cash/trust, backed amounts, unallocated cash and pool
deficit. Stale, missing, currency-conflicting or pending evidence changes backing,
not confirmed intent. A pool below total intent retains that intent and withholds
every individual current-funded claim, with no prorating. Payment or a reduced
goal requirement does not release intent; only a later owner-confirmed snapshot
does. Targets stay in incumbent commitments, yearly bills, group members and
`budget-reserve` `plan.budget.categories` rows (class `reserve`),
counted once. Silver already in observed pool cash is counted once, without
inferred attribution. Inter-pool transfers change location, not purpose or income.

This inventory is a **non-additive breakdown** of observed reserve cash. The
incumbent ACR still uses the designated reserve once; it is not increased by goal
amounts or by a second pool. With configured earmarks, reserve-specific current
evidence governs ACR backing and a stale reserve does not invalidate unrelated
operating cash. Incremental savings instructions remain withheld unless explicit purpose
reserves have confirmed assignments and current, clear backing **and** every
usable seed matches its projected payment cash component. Unknown starting
assignments are not zero saved. Displayed funding alone is never subtracted to
claim feasibility. Proposals never become actual saved. Legacy configurations
without explicit purpose roles retain their existing withholding and ACR rules.

**Present reported savings earmarks — owner directions 2026-10-07 and
2026-10-12.** The two reserve locations are one combined reported pot. Dale's
October 7 directions (`Sentinel_93de0961f58c8191ac98162a7b6ea3bc` and
`Sentinel_167168c4776481918bb76489464de7a7`) allocate it to unpaid planned
requirements in chronological order until exhausted; later increases grow the
next item. His October 12 confirmations
(`Sentinel_9c2c91baaecc8191864198c3239a701c` and
`Sentinel_36ee0e8c765c8191abc9691e180abfec`) make the latest known Lunch Money
reports the source between checks. A report becoming older does not erase its
calculated earmarks. Forecast replaces that allocation when the reports change;
it does not accumulate another contribution or subtract old transactions from
an already reported balance.

`recommend.savingsFunding.goalAllocation` is this dated present earmarking,
not historical transfer reconciliation, verified payment backing, money moved,
paid status or a promise of new Bills cash. Both distinct reserve identities,
native CAD cents, valid source/check/balance dates and uniquely dated/priced
requirements remain required. Missing or malformed account evidence remains
unknown; negative stock and unresolved protected requirements retain their
holds. A uniquely qualified native-CAD posted inter-reserve pair that is
demonstrably present in both reported account snapshots retains a narrow
account-cohort contradiction hold until a coherent report arrives. Amount,
nearby date or merchant similarity never establishes that pair. Historical
transaction-window/posting uncertainty, unpaired old savings
debits, pending movement and unknown card payment purpose do not blank valid
reported earmarks. They still qualify current payment backing, new operating
contributions and the future funding walk through the incumbent independent
gates. The source check and balance dates stay visible and separate. This
includes same-day paired reserve movements: date-only equality does not prove
that a transfer is included in both reports, so current earmarks retain the
reported sum without adjusting it. Pending movements, account-scoped
`savingsMovementUnconfirmed` flags and truncated transaction coverage likewise
cannot erase independently valid dated account reports. Their native backing
and contribution holds remain explicit; explanatory copy must not say that
visible reported Saved is withheld. Only the positively proven opposite-cutoff
duplicate described above withholds the present allocation. This is the
latest-reported-balance contract, not a claim that the reports are current bank
backing or that a same-day movement has been reconciled. This
supersedes earlier use of movement reconciliation as a present Saved gate;
there is still one Forecast chronological allocator and no new policy/input
store. Dale's October 12 transaction-view direction
(`Sentinel_60223df7f05481918e81b31b1d972fe8`) does not require obtaining card
statements again and does not establish an empty card-coverage opening.

**Future Savings closing projection - owner direction 2026-10-13, amended by
owner direction 2026-10-14 (payday-surplus sweep; Dale-confirmed, assigned via
Atlas) and further amended the same day by the S1 payday-sweep/carry
correction (Atlas-approved). Where they differ, the S1 semantics govern
the sweep's measure and the Budget opening's consumption of it.**
`Forecast.recommend.savingsFunding.periodViews[].packet.forecastClosing` owns
the selected future period's closing pot and per-requirement allocations if
eligible surplus is saved. It consumes the incumbent Budget forward cash walk,
its income/bill/Household Budget deductions and protected floor. The generic
deadline-minimum scheduler remains that scheduler; it does not supply this
surplus scenario. Positive period surplus moves location on the following
payday: a period's eligible surplus is swept into projected Savings at the
start of the next period, in full, and the new period's own income is never
part of that sweep. Eligibility is bounded by the Bills cash that actually
exists at the period's close: a positive period net first absorbs any
carried Bills deficit, and only cash that remains can move (Systems Review
2026-10-14 — this bound is availability, not future-needs retention). Native
goal expenses occur once and leave the projected queue. Routine deficits stay
in Bills and are published explicitly on the close (signed operating cash
plus the period's first floor breach); projected Savings is never drawn to
cover them, and no part of a surplus is retained in Bills for future
operating need. Whether a deficit is funded from Savings or a bill is
rescheduled is the owner's decision. Dale's clarification
`Sentinel_98d4486829848191b933e14411bbc3cd` permits the qualified hypothetical
Savings remainder in this forecast calculation only. It authorizes no real
transfer, reserve withdrawal, loan or native/current money movement.
Owner clarification 2026-10-16 (`ownerSentinel_f70d821f734481919f25b706ea7ab1a6`):
the current period's hypothetical contribution uses its expected income minus
planned bills and Household Budget (planned reserve fulfilled by spending up
to budget; overspending increases the deduction). It is independent of today's
transfer capacity and future operating needs. The existing qualified current
reserve/operating opening, complete movement and matched receipt/transfer
inclusion evidence still apply. Unreceived salary stays forecast, including
on or after its expected date; a hypothetical receipt at the current close
keeps the scenario's operating and Savings legs conserved. Received amounts
already in reported Savings replace their projected credit exactly once.
The bank-transfer publisher and its cash-floor/receipt guards are unchanged.
The future S1 sweep remains the published waterfall amount. Signed planning
and operating deficits stay visible; no negative actual transfer or automatic
Savings draw is invented. A reported increase is never evidence of its income
source. Missing opening/inclusion proof, native cash coverage, required
amounts/dates or income authority keeps the closing projection unknown.
Current Saved remains the reported earmark;
future actual Saved, transfers and settlement remain unknown. Estimated scenario
trust and provenance stay internal. The selected period supplies visible context;
Dale's 2026-10-14 UTC direction (`Sentinel_fd7dfe558f4c8191ad91f6f2379ad41d`)
supersedes added Forecast/Actual labels, badges and ordinary assumption reminders.
Genuine unavailable-data failures remain visible. Both renderers copy this
publication, qualified by `savingsFundingPublication`, without financial math.
Native planned payments on or before the inclusive close consume their costs
once and remove their requirements only from that projection. Installment groups
retain their remaining members, then disappear. Earlier affordable closes survive
a later unavoidable native funding gap; the failing close withholds allocations
and reports that same gap. Navigation never mutates actual settlement or balances.
The closing stock's internal basis is
`opening-savings-plus-eligible-surplus-minus-goal-costs`:
qualified opening Savings plus eligible period surplus swept on following
paydays, less full due goal costs. Operating opening
cash cannot inflate this headline or replace a signed Savings shortage. Goal bills
already deducted by native Budget contribute only their exact unique deduction
to the pre-goal quota before the full cost debit. Signed Savings diagnostics
continue across closes; negative Savings withholds stock and allocations. A routine
Bills floor breach no longer withholds publication (superseded 2026-10-14):
the close publishes its stock with the signed operating position, and the
former retention search, minimum coverage plan and daily qualified-cash
floor gate are retired — the sweep is the full eligible surplus, Savings
never covers a Bills deficit, and the qualified cash path is diagnostic
only. Native reserve events cannot reuse stock already consumed by goal
costs. A later
receipt never retrospectively qualifies an earlier shortage. Existing positive
net-surplus eligibility is unchanged; late non-surplus receipts remain Bills carry,
without an automatic repayment to Savings. The full native economic
expense, actuals and operating publications remain unchanged. The existing
current-tail unavailable gate is unchanged, including its positive-planned-capacity
condition, and a schedule funding-gap status cannot override it.

**S1 amendment (2026-10-14, via Atlas).** The sweep's measure is no longer
the period's net surplus. `calendarPeriodWaterfalls` computes one
Forecast-owned sweep per future period — the period's full positive
available Bills remainder, inherited opening cash included — and publishes
it on the period as `paydaySweep`. The available remainder is the physical
cash leftover: the internal cash-after-Household-Budget figure notionally
deducts the period's savings-funded annual-bill provision, but that
provision is not a Bills payment (the Savings ledger debits the goal cost
itself), so the provisioned cash is part of the remainder. The Future
Budget opening consumes exactly the published sweep (the next period
opens from the remainder minus the sweep), and `savingsClosingProjection`
credits the same figure, so the two publications cannot disagree; a
negative remainder sweeps zero and carries into the next opening in full,
staying visible. Goal-bill overlap is restored inside the waterfall before
publication, and Savings credits the published sweep unchanged while debiting
each goal cost once. The new period's own paycheck and all other accounts
are excluded.

**Owner simplification (2026-10-15 23:40:51 UTC).** Publish the dependent
sweep chain only from a directly observed payday-boundary Bills basis or
a fully reconciled basis with complete, fresh evidence. Current Bills cash
already includes posted inflows and transfers; neither is applied again.
An unknown, stale, conflicting or invalid numeric input stays unknown,
including when a transfer pairs or an independent current funding amount
is READY. Unknown sweep means unknown dependent Budget openings and Savings
closes: Savings must not substitute net surplus plus overlap. Zero is valid;
negative Bills remains a visible shortfall. Reconstructed pooled openings,
unattributed scalar cash and midperiod stock without a qualified boundary
may be withheld; no historical-share inference or reconstruction exemption
is required. The #618 opening authority and independently supported current
funding facts remain unchanged. The current period's receipt-qualified
entitlement path remains separate; projected cash never proves settlement.
This supersedes
the net-surplus-only sweep measure and any pin that left Budget opening
figures unchanged by the sweep; the rest of this section (deficits
published, never covered from Savings; no hold-back; costs debited once;
projected transfers never establish settlement) is unchanged.

**Owner simplification decisions (2026-10-29).** Dale ruled directly to
Muse (2026-10-29 ~21:46 PT); the record is issue #787 (comment
6515215675) and the Owner Decisions Register #765 (comment 6515217463).
Decisions 1, 2 and 3 are settled and are not re-asked.

**Decision 1 (settled): future-period Savings publishes tagged
ESTIMATED, not withheld, when a movement cannot be uniquely qualified.**
Savings at period close and per-goal Saved are shown, with the reason
named. This amends, for future-period Savings publication in that case
only, the withholding stated earlier in this section — "Unknown sweep
means unknown dependent Budget openings and Savings closes", "Missing
opening/inclusion proof ... keeps the closing projection unknown", and
future Saved remaining unknown: in the unqualified-movement case those
figures publish tagged estimated instead. Current-period, verified and
posted figures are unchanged, and future transfers and settlement
remain unpublished as actuals, as stated above. The Savings pool rolls
forward across future periods. Goals whose dates have passed retire
from later periods; retirement is not erasure — the goal remains
visible in its own period.

**Decision 2 (settled): Still to fund = max(0, Needed − Saved), tagged
estimated, in current and future periods, when both Needed and Saved
are known.** When both inputs are known it is never "Unknown" and
never presented as verified; when either input is unavailable, the
unavailable input is preserved as unknown and no numeric funding gap
is manufactured. Paid stays as-is until paid tracking exists.

**Decision 3 (settled): Scenario 6 is narrowed.** A failed refresh
shows the last good data with its date; nothing is counted twice;
nothing stale is labelled "Now". Restore-authority protection (INT-4,
P-8, anchors, fencing) is NOT a release requirement unless Dale
explicitly asks again.

**Proposal A (adopted): the ATLAS-080 activation path is PAUSED/FROZEN
— frozen, not deleted.** Savings remains production-inactive by freeze.
Under the freeze there are no builds or dispatches on that path
(storage, custody, restore, INT-3/4/5, anchor work, key custody
ceremony, production host composition, S4 composition, the activation
packet); records may still land.

**Proposal B (direction, not built): purchase→goal assignment moves to
a Lunch Money tag contract, and planned inputs become ordinary
data.json edits via git.** The contract is explicit; the adapter is
narrow and validated; Atlas reads Lunch Money GET-only. Acceptance
proof covers pending→posted, split, refund and reassignment, with
parent/child conservation. No B build before the adversarial verdict
and Atlas's disposition.

**Every concept has one owner.** A new piece of work either consumes an existing
owner or explicitly replaces it; it never quietly becomes a second one.

| Concept | Owner today |
|---|---|
| Direction, boundaries, capability gates, the secret boundary | **this file** |
| Who decides, who reviews, what a pull request carries | [`CLAUDE.md`](CLAUDE.md) |
| Work and findings | [`BACKLOG.md`](BACKLOG.md) |
| What only the household can answer | [`docs/01_OPEN_QUESTIONS.md`](docs/01_OPEN_QUESTIONS.md) |
| Standing facts — rates, limits, due dates | [`docs/ACCOUNT_FACTS.md`](docs/ACCOUNT_FACTS.md) |
| Sequencing of planned capability work | [`docs/ATLAS_FINANCIAL_BUILD_STRATEGY.md`](docs/ATLAS_FINANCIAL_BUILD_STRATEGY.md) |
| Whether an explicitly identified supplied evidence item has been routed or parked | [`docs/evidence_use/register.json`](docs/evidence_use/register.json) |
| An explicitly identified **external-reference** claim — general, domain or institution-published knowledge that is not a household fact — with its provenance, freshness, and the `docs/` surface it may inform | [`docs/knowledge_evidence/register.json`](docs/knowledge_evidence/register.json). Explanation only: never a household fact, Forecast input or output, owner policy, provider evidence, or financial permission |
| Agent context architecture — authority vs skills vs learned lessons | [`docs/AGENT_CONTEXT.md`](docs/AGENT_CONTEXT.md) |

### Evidence-Use Register

The register owns **routing and parking**, not financial values. It is an index
over existing authorities, not a sixth architectural layer and not a second
roadmap.

For each explicitly identified evidence ID it records exactly one of:
`CONSUMED`, `PROPOSED`, `UNRESOLVED`, `SUPERSEDED`, or `EXCLUDED`.

**`CONSUMED` means the item is routed to a named incumbent that exists.** It
does not mean the incumbent figure is financially correct, current,
independently verified, or correctly trust-labelled. Pointer existence is not
a green financial proof. Correctness stays with the incumbent, independent
evidence, and the normal figure / review gates. The register does not prove
value freshness: changing a routed payroll amount can still leave CI green.
After `B91` exists, fold or derive the useful routing protection into that
loop; do not delete the register until that replacement is proven.

CI covers **declared IDs only**. It cannot read Markdown and decide what is
material. An unidentified sentence is outside this gate.

### Atlas is not greenfield

The financial authorities below are **incumbent**. Later work evolves, derives
from, replaces or deletes one of them — and says which. It does not stand up a
second engine, a second weekly figure, a second budget or a second calendar
beside them. This repository has already shipped that failure, publishing
`$1,650/wk` in one tile and `$0/wk` below, because two pieces of code answered
the same question. The schedule overlap that used to sit under this table is
closed: `Forecast.expandEvents` is the one cash calendar.

| Concept | Incumbent authority |
|---|---|
| Explicit private card-payment choice preview | `Forecast.validateCardPaymentDecision` delegates to the existing `reconcileCardPurchases` / `Forecast.cardPeriodMovements` qualification, including aggregate claim conflicts and complete provider evidence. It validates one privately resolved proposed declaration and returns sanitized allocation facts; it creates no matching policy, opening, available cash or issuer satisfaction. The inert `scripts/card-payment-decisions.js` foundation is its private caller. |
| Expected active-period Bills closing balance | `Forecast.billsAccountPeriodBalance` derives a separate Bills-only estimate from dated posted `chequing-a` cash, qualified unreceived income, incumbent remaining occurrence cash, and the active Household Budget hold less proven Bills funding. Paired Weekly transfers/returns, eligible direct Bills purchases and explicitly reconciled current-Budget card backfills fulfill funding once. Existing pending Bills household cash and uncovered current-category card requirements floor the remaining estimate; earlier/noncategory card carry is protected separately once. Aggregate target attribution is estimated with a stated basis, never verified per-category allocation, implicit overdraft funding, or transfer permission. Eligible native remaining amounts are checked before lossy calendar/event projection: missing or nonfinite is unknown, not zero. Explicit other cash payers are excluded from Bills stock; unknown explicit payer ids withhold it. Unassigned household costs retain the disclosed owner Bills funding anchor. Incomplete/ambiguous native coverage withholds the projected total while known Bills stock survives. The Budget card renders this publication; old BAD, Month, Road Ahead, Savings and signed A+B planning contracts remain unchanged. |
| Selected Seaspan pay-period liability movement — Travel, Cash Back, Emerald, Triangle, Amazon Mastercard and the recorded HELOC | `Forecast.cardPeriodMovements`, with the Forecast-owned `public/forecast-card-period.js` module. Read-only posted liability reporting from the incumbent sanitized `currentPeriodActuals`; canonical card identity or the existing native `heloc` account role, explicit CAD whole cents, selected Forecast payday boundaries, completed provider pagination and distinct pending evidence. Numeric net requires independently qualified posted balance endpoints in read-only `cardPeriodBalanceEvidence` (`atlas-card-period-balance-evidence/v1`), matching temporal claims and evidence references, and agreement with every posted charge/payment/refund/interest/fee/adjustment in that interval. A missing, null, object or other non-array `transactions` container is not an empty ledger and cannot claim complete reconciliation; only an explicit empty array may support a calculated zero when independently qualified endpoints agree. The same native source identity (`id` or `coverageRef`) cannot establish two card mappings or both a posted and a pending row; date eligibility does not prove independence, so a malformed, pre-window or post-through counterpart still withholds the affected cards. Conflicting `atlasAccountId`/`account` aliases withhold the affected cards while independent cards remain publishable. Missing endpoints, untrusted units/dates/identity, incomplete coverage or discrepancy withholds net rather than inventing an opening or balancing row. Current providers do not manufacture arbitrary payday openings; absence stays unavailable. Same-date balance history and card-purchase cash earmarks are not substitute openings. Manual Triangle/MBNA remain visible with their actual dated/unavailable evidence. Observed details can remain qualified without a net. This neither settles household minimum allocations nor determines issuer treatment, adds expense/cash/debt deductions, publishes available cash or grants spending permission. `public/plan.js` copies this publication; Budget layout/style only place it after the period/current-position block and before Household Budget/Bills. |
| Minimum-category sender ownership across identifier namespaces | `Forecast.minimumCategoryAllocationConflict` is the shared withholding guard consumed by observation and Forecast before a derived minimum receipt. Explicit movement references and verified distinct provider debit identities establish independence; compatible human-labeled owner allocations with unknown linkage withhold derived proof. Amount/date/account compatibility never establishes settlement, creates allocation or replays cash. Existing owner records and receipts remain authoritative. |
| Posted income before an unresolved future occurrence | `Forecast.incomeReconciliationState` consumes the read-only observer's transient `plan.opening.incomeReconciliation`, qualified to that opening. Native CAD posted employer income into Bills, or an employer-source/paired Bills transfer packet, may overlap the next native scheduled receipt without establishing settlement. The observer bounds uncertainty to complete current coverage after the preceding native income occurrence; both Amanda salary slots share that interval. Consumed evidence is excluded. Duplicate qualified legs withhold claims and never settle an occurrence. Forecast retains observed balances and scheduled facts, but withholds dependent cash projections, spending permission and income guidance; API and Budget render the same reason. The marker rebuilds on every refresh and is not an owner assignment, holiday rule, automatic early settlement, canonical writer or new income stream. |
| One statement minimum occurrence | `Forecast.obligationOccurrences` replaces exactly one original scheduled occurrence with its `statementOccurrences` minimum and due date. Amount confirmation (`confidence: confirmed`) does not promote the due date: optional `dateConfidence` (`confirmed` or `estimated`) is published separately through expandEvents, settlement rows, and Plan. Omitted `dateConfidence` remains a fully confirmed statement-date override. Later recurrence estimates remain unchanged. `Forecast.statementOccurrenceDate` maps its stable original identity to the effective due date for represented-event qualification. Replacement happens before window filtering. `Forecast.statementOccurrenceIdentity` resolves original keys and unique due-date aliases; replacements cannot cross another original occurrence. `Forecast.representedOccurrence` applies the same opening-qualified identity contract to posting reconciliation and canonical previews. Provider posting, live cutover and canonical proposals retain original keys separately from cash dates. Conflicting, invalid or non-CAD statement overrides are rejected; statements do not update opening debt stock. |
| Card minimum money sent versus issuer satisfaction | `Forecast.cardMinimumState` consumes explicitly confirmed, exact `sentPayments` evidence on the incumbent obligation. Pending/refund/ambiguous intent and purchase backfills do not become minimum allocations. Exact bank-side sent evidence does not manufacture representedEvents or issuer principal reductions. Unknown cash inclusion or issuer satisfaction withholds operating permission and the trajectory, with additional issuer cash unknown. Independent existing represented-event proof can establish issuer satisfaction for one original occurrence subject to its cash-opening qualifier; legacy names cannot prove satisfaction before their attached opening. Forecast.cardMinimumReceiptIdentity validates one original occurrence in the optional minimum contract. Live refresh preserves that issuer knowledge beyond the due date and retains a legacy proof's earliest attached opening as its effective qualifier. Durable proof does not broaden cash replay eligibility or supply another principal reduction when no minimum-intent allocation exists. Supported canonical opening proposals also retain this qualified knowledge; their approval fingerprints, installation and validation preserve effectiveAsOf. Sent evidence remains annotated even in represented debt walks and never replays principal against observed stock. Unconfirmed funding withholds standalone/grouped plan verdicts, period remainders and unallocated cash while contractual costs and observed balances survive. Runtime/publication omits debit evidence identifiers. These optional fields carry no private source documents and authorize no provider writes. |
| Scheduled amounts that cannot be parsed | `Forecast.scheduledAmountState` reads each carrier's effective scheduled amount at source selection — for obligations, the occurrence amount after statement replacement and before coercion or caps; a valid statement minimum supersedes a bad fallback for that occurrence, and a later occurrence still falling back to the bad amount blocks. A present-but-unparseable amount (null, NaN, a comma-grouped string, a boolean, an object) and a dated protected point requirement with a missing amount and no valid range are unknown — never zero and never a NaN cash event. `Forecast.expandEvents` emits no event for the row, and simulate, recommendWeekly, recommend, majorPlans, paydayAllocation, projectDebts and the baseline trajectory withhold the affected totals and dependent spending/funding claims while independently known stocks and totals survive. The calendar period waterfalls apply the same detector to their bill load: an unknown bill or obligation amount in a window makes that window's periodBillLoad unknown (commitments never enter the bill load), extending the incumbent bills-only arm to obligations on the same exclusions. Valid null-plus-range commitments, undated informational rows, optional, disabled and settled cases, and genuine zero are preserved; malformed statement-contract input keeps its incumbent throw. |
| Shared savings publication qualification | `Forecast.savingsFundingPublication` selects the existing publication against the native opening, currency, permissions and current/selected period. It performs no financial arithmetic and borrows no legacy alias. Budget, Plan Spend and SavingsInventory share this boundary; missing, stale or malformed current publications hold precise backing/proposals together while independently qualified pending stock stays known. |
| One chronological savings pot and current/projected funding | `Forecast.recommend(...).savingsFunding`, produced once by the incumbent `Forecast.savingsDailyFunding`, owns calculated backing under dated `plan.savingsEarmarks.allocationPolicy`. The October 7 owner policy combines the two existing reserve locations; physical pool goalRefs/history no longer determine current eligibility or priority. Native funding, recurrence and settlement provide one unpaid occurrence roster, including annual card bills and dated Budget reserves. Whole-cent observed stock fills dated requirements globally, once, with one partial frontier; groups are reprints after settled-member filtering. Known requirements survive unavailable stock. Undated/ranged/overdue requirements keep conservative protection; no date, transfer or confirmed assignment is invented. Private exact payment components seed the same native walk and serial schedule. Budget's Savings, Costs ahead and Saving for views, selected-period lenses and Plan Spend select this single publication; the legacy schedule field aliases it. Current backed cash remains separate from unsent/current and future projected top-ups, and actual saved/transfer fulfillment remains unknown without evidence. Existing operating/card/income gates reach every lens without erasing independently known stock. |
| Effective date of represented cash movement | `Forecast.representedEventEffectiveBy` qualifies optional `effectiveAsOf` on each `plan.opening.representedEvents` / `opts.representedEvents` entry before the incumbent occurrence rules apply. It means the earliest cash opening proven to include the movement, independently of scheduled due date, intent confirmation or issuer receipt. An explicit date must be a real `YYYY-MM-DD` on or before the cash-walk opening; a later or invalid date cannot suppress replay or publish represented status. Legacy `{id,date}` entries retain their existing assertion that the movement is already inside the attached opening; absence is not a way to encode a newly confirmed post-opening payment. `live-plan` qualifies newly observed names at its fresh live cash date and preserves explicit dates through merges, including inactive deferred names. A duplicate id/date prefers currently applicable proof over an inactive deferred or invalid entry and retains the earlier truthful qualification; an inactive name cannot shadow fresh applicable evidence. Deferred names cannot remove an unproven-inbound hold. Same-day unproven-income guards are rebuilt without treating a prior hold as absence of the occurrence, and a hold remains until applicable proof resolves it. `scripts/reconcile.js` `representedOnOpening` and the `representedEvents` `readCanonical` branch apply that same Forecast qualifier, so posting receipt and canonical-preview classification cannot report a later or invalid date as represented while Forecast still applies the movement. This qualification grants no new settlement identity, minimum-payment intent, issuer-receipt proof or class eligibility, and changes no historical stock. |
| Hypothetical savings funding timeline | Under the combined owner policy, the bounded location projection lives only on `Forecast.recommend(...).savingsFunding.timeline`, reprinting that run's native cash walk and serial schedule. Projected internal top-ups decrease operating/increase savings equally; current-backed and future-top-up draws consume the single matched expense once; future receipts enter on their modelled date. It grants no actual transfer, account routing, spending or borrowing permission. Unsupported income horizon, cash evidence or draw identity withholds the projection. Historical pre-policy `Forecast.savingsFundingTimeline` remains a dated legacy primitive; the standalone function withholds a rival current combined projection. |
| Confirmed received-income amounts | `Forecast.incomeReceivedAmount` reuses the incumbent calendar receipt contribution with explicit received status, finite numeric actual and eligible settlement/trust guards. Named income and Other Income detail consumers and `Forecast.budgetPeriodProgress` use the same receipt magnitude; planned amounts are labeled separately. Missing actuals are unavailable, never planned fallback or coerced zero. |
| Confirmed goal earmarks and observed savings inventory | `Forecast.savingsEarmarksState` strictly validates physical reserve identities, dated manual history and the narrow owner allocation policy. `Forecast.savingsInventory` retains separately dated provider-reported account stock and historical manual confirmation evidence. After the combined policy becomes effective, those pool assignments are not a rival current allocator: Budget and Plan Spend render `recommend.savingsFunding` through `public/savings-inventory.js`. Existing commitments, yearly bills, group members and `budget-reserve` categories own requirements; none is copied into a second canonical store. Before the policy's effective date, the historical dated policy/evidence applies. Unknown confirmed intent remains unknown; calculated current backing is not manual confirmation or money moved. |
| The schedule — what is due, when, how often | `Forecast.expandEvents`, via `simulate`, from the `plan` inputs. An unresolved known once cash obligation still on the plan remains binding when Forecast start advances past its reservation date; the event keeps that scheduled date rather than acquiring the caller's start, and the cash walk still deducts the amount at this opening. The coupled `projectDebts` walk applies that same cash obligation at this opening via the same `cashWalkDate`; absorption still keys the original scheduled date, so `recommend` cannot drop the carried amount after caps. Advancing as-of is not settlement evidence. Received once income keeps window semantics. Non-cash once charges keep window semantics so a historical capitalisation is not applied again. Settled once outflows are removed, named on `representedEvents` for this start, or encoded as `firstDue` on the recurring row. Dated occurrences already inside the opening observation may be named on `plan.opening.representedEvents` or `opts.representedEvents` and are omitted only when that date is the simulation start (`plan.opening` only when its `asOf` is that start), except that a live overlay may set `plan.opening.priorAsOf` so represented names in `(priorAsOf, asOf]` also suppress replay. Unrepresented joint-cash outflows in `(priorAsOf, asOf)` remain on `expandEvents` and are applied at this opening via `cashWalkDate`. Unrepresented recurring card-paid reserved bills in that same interval remain on `expandEvents` and are applied at this opening via `cashWalkDate` as reserved gravity; they do not become joint-cash withdrawals. `Forecast.carriedOnceJointCashOutflow` permits an exact older represented id+date to suppress only a past once joint-cash outflow that Forecast still carries at this start; it cannot backfill income, recurring events, non-cash charges, or a merely similar occurrence. `Forecast.prepaidJointCashOutflow` permits an exact represented id+date to suppress a still-upcoming joint-cash obligation or bill occurrence after this start when identity has already named that occurrence, including a capitalising obligation's encoded cash-minimum date which shares that obligation id and is not the non-cash capitalise row; commitments still use `settledOn`, and recurring income is not prepaid this way. A future represented date is ignored for every other class. That list is opening-date settlement evidence, not a date-wide skip and not a second event engine. A dated commitment cash date is `Forecast.commitmentCashDate`: a stored valid `YYYY-MM-DD` `date` wins; otherwise a single clear month-and-year `when` (`Mon YYYY` or `by Mon YYYY`) is the 15th of that month. Spans, seasons, missing years, `late`/`around`/`early` wording, TBD, Christmas-as-month, and annual fail closed. Pages do not invent a day. A dated commitment may carry `settledOn` (a `YYYY-MM-DD`). `Forecast.commitmentSettledBy` treats that cash requirement as already satisfied only when the date is on or before the simulation start. A live overlay `priorAsOf` lookback still uses that same Forecast opening as the settlement cutoff: a valid `settledOn` on or before this opening is not re-funded merely because the inner expand window starts at the earlier origin. Unrepresented recurring joint-cash bills in `(priorAsOf, asOf)` remain reserved. Unrepresented recurring card-paid reserved bills in that same interval remain reserved. The record stays; its scheduled date does not move. Human-readable historical status is derived from the date's presence. Sinking-fund and estimated-commitment risk use the same helper. `representedEvents` is not used for this. A dated bill may carry `payingAccount`. `Forecast.billIsHouseholdObligation` is true unless the bill is explicitly `householdObligation: false`; paying-account metadata never flips that. `Forecast.billAffectsJointCash` suppresses joint-cash deduction when the paying account is on `plan.startingCash.heldElsewhere`, or when the bill is card-paid (`Forecast.isCardPaidBill`: payingAccount is a known obligation `debtId`, or explicit `jointCash: false` that is not held-elsewhere). No payingAccount, a `breakdown` payer, or an unknown/typo id fail closed and still deduct. A card-paid dated bill is still on `expandEvents` and is reserved on its planning day; it does not deduct chequing and does not capitalise onto the card. An externally paid household obligation still appears on the `expandEvents` schedule and in `Forecast.nextDue`; `Forecast.simulate` and `Forecast.nextPaymentOut` do not treat it as cash leaving the joint pool. A utility account balance is not a bill |
| Cash projection over the window | `Forecast.simulate`. `opts.horizonDays` walks the master; `opts.viewDays` slices the same walk for display; `opts.viewStart` may begin that slice after as-of so a custom range is a real offset, not an as-of prefix of the same length. A sliced week recomputes its in-range income, bills, obligations, variable, reserved and other aggregates from the clipped events and days; it does not keep the original week's full totals. Default remains `plan.windowDays` so a caller that has not asked for the master still gets the view. Undated `plan.budget.categories[].currentMonthly` (when it wins over an owner target) is reserved as daily cash on this walk, using the calendar month `365.25 / 12`, so a card-paid current-regime service without a trustworthy day exerts gravity without a fabricated due date. A dated card-paid bill is reserved on its planning day on the same `week.reserved` / `totals.reserved` ledger, not as `week.bills` and not mixed into the weekly-cap variable/Budget column. Neither form is a second event engine. Spendable opening is `startingCashAmount`: household chequing-only (`HOUSEHOLD_CHEQUING_IDS`, the same identities as `Forecast.postedHouseholdChequingCash`) when those rows exist on the breakdown; designated `savings` / EMERGENCY SAVING stays on the breakdown as reserve evidence and is not spent on the walk (owner 2026-09-18, Case K). `additionalCashRequired` is `max(0, 0 − min.balance)` on that chequing-only carry-forward walk — the same zero-floor identity as `shortfall`, and the total future cash funding required. Designated savings does not reduce this walk figure. Forecast-owned backing of that total (`fundedByDesignatedSavings` from actual `savings` / EMERGENCY SAVING evidence, then `remainingAdditionalCashRequired`) is published on `Forecast.baselineTrajectory.additionalCashRequired`. Funding floor is $0, not `targetBuffer`, and not a new emergency buffer. Period month/pay-period `stage*.result` deficits must never be summed to derive this requirement Explicit purpose-reserve payment components come from current `Forecast.savingsInventory` backing and the incumbent `fundingSequence`; `expandEvents` retains the full expense and annotates only one matching occurrence. `simulate` applies its operating portion and publishes the reserve-funded portion separately. This is projected use of already-backed cash, not income, an injection, a transfer, or generic ACR backing. Missing matching cashflow proof leaves the full incumbent operating cost in place. |
| Spendable household cash and the unknown chequing opening | `Forecast.spendableHouseholdCash` is the one published "Spendable household cash" figure: the same household chequing pool as the walk seed `startingCashAmount`, or null (Unknown) when any household chequing opening row is unknown. `Forecast.householdChequingRowValue` is the one reader of a chequing row's numeric evidence (ATLAS-078 rulings A/B: `unknown: true` is unknown before conversion; null/absent, blank, boolean, object, non-numeric and non-finite values are not evidence; finite numbers and numeric strings, zero and negatives included, are). `Forecast.openingCashState` is the gate: one unknown household chequing row makes the whole pool unknown, never $0. When it is unavailable, `simulate`, `recommend` (current operating plan unavailable), `paydayAllocation`, `baselineTrajectory`, `planSpendPaydayFunding`, the period openings and `deepDive.cashAmount` withhold every walk-derived figure, and pages print unavailable. `startingCashAmount` remains an internal walk seed only; no page calls it. Savings rows are outside this gate. |
| Knowledge horizon — how far the master forecast knows | `Forecast.knowledgeHorizon`. At least twelve months for every plan, independent of whether recurring streams exist, and always long enough to include every dated unsettled commitment, including range-only rows that have a cash date (`Forecast.commitmentCashDate`) but no point amount. Rows with no cash date do not extend it and do not become cash events. The visible range is not an input |
| Weekly household cap | `Forecast.recommend` — **and only it**. The weekly search walks `Forecast.knowledgeHorizon`, not the visible range, so a dated commitment outside the span on screen still binds today's figure. Undated protected principal and still-unsettled dated-range principal are encumbered against the same master walk, so a known undated commitment or a funded-but-unpaid dated range constrains today's cap rather than being labelled after the fact. An unsettled dated point commitment whose scheduled date is before as-of remains protected principal until `settledOn`, cancellation, or authorized release; passing the due date does not invent a new due date and does not turn the unpaid amount into spendable cash. Overdue protected point amounts and overdue dated-range floors are an as-of constraint: current surplus after the model buffer and same-day authoritative cash effects must cover their aggregate floor, so later horizon income cannot make a past deadline look feasible. A passed ranged deadline keeps its original date and its min/max; it is not tested against a simulation day that does not exist. Explicitly authorized planned debt may close that current gap only through the existing same-walk financing path. Opening-gap detection stays on the visible opening so a later shortfall cannot become an Amanda/HELOC injection today. Opening-gap recovery may spend only non-debt cash the household already owns; a `debtId` option is borrowing capacity, not automatic permission to draw, and cannot make an otherwise-unfunded opening gap feasible or raise the weekly cap. When even zero discretionary spend cannot keep the protected plan feasible, `Forecast.recommend` returns `mode: infeasible` with the first failing constraint, date, dollar shortfall and affected commitment; it does not publish `$0/week` as a feasible safe-to-spend answer. `holds` is that same protected-feasibility predicate (cash buffer, still-encumbered principal including overdue unsettled point amounts and overdue dated-range floors, every still-future dated-reserve deadline). The same result derives `nearBoundary` from existing `zero.events`: named joint-cash outflows on the next payday date and the following calendar day. That list is payday-output visibility, not a second horizon. The same result attaches `paydayAllocation`, the payday waterfall `Forecast.paydayAllocation` owns |
| Payday allocation — what current household cash must do this payday | `Forecast.paydayAllocation`. One waterfall on current spendable cash (`startingCashAmount`: chequing-only when household chequing identities exist; designated `savings` / EMERGENCY SAVING is reserve evidence, not this opening) plus same-day income: required joint-cash obligations (including overdue protected floors and commitments due this period), essential household costs from incumbent budget classifications (a cash hold, not a second spend permission — `Forecast.recommend` remains the weekly spending authority; when coverage-current `opts.currentPeriodActuals` exist, future consumption need is the period plan minus classified posted and observed pending actuals, floored at zero. Settled cash actuals are already in current cash, and card actuals remain debt exposure, so neither is deducted again as pending cash. This is not the frozen payday-period Household Budget deduction: that separate snapshot uses max(planned, actual) plus Other Spending under the 2026-09-04 contract. The current-cash hold does not use a remaining-days reslice that would ignore spend already observed), protected future-path cash derived by probing the incumbent `protectedPlanCheck` master walk (the largest same-day surplus outflow that still leaves the protected plan feasible; the remainder of leftover cash is protected current cash — one coherent result, not a payday-interval residual, not a second buffer subtraction, not Q20, and not a fixed payday cushion). Owner 2026-09-18/19 Prepare Ahead is that same `protectedPath` hold: leftover current chequing cash that cannot be removed today while `protectedPlanCheck` still holds, so the already-modelled future trajectory survives. It is keep-in-chequing protection from spending and extra debt, not `additionalCashRequired`, not remaining ACR split across paydays, and not a transfer into designated Savings to fund ACR. Designated Savings remains evidence of set-aside cash, not this payday's protection amount. The published `protectedPath` packet is the household reprint contract: copy `allocated` when `status` is `calculated`; `identity` is keep-in-chequing leftover after obligations and essentials that cannot be removed while `protectedPlanCheck` holds; `source` is `Forecast.paydayAllocation`; `designatedSavingsBacking` is `not-used`. `wanted` is the walk need, not the reprint; `movable` remains extra-debt eligibility after the hold, not Prepare Ahead. When `Forecast.recommend` withholds the current operating plan, `protectedPath` fails closed (`status` `unavailable`, amounts null) rather than publishing a stale calculated hold. A later page reprints those fields without arithmetic, without ACR, and without a Savings transfer. Extra debt receives only proven `movable` surplus after this hold and dated `futureCosts` set-asides. Observed unresolved household-cash debit principal retained in that same protected cash path before surplus release regardless of category (including Other, discretionary, and zero-target essential categories). The current-cash removal ceiling excludes that principal, and the payday-only master feasibility probe includes its debit so future protections cannot reuse it. These constrain the same cash once, without a new budget bucket, bill, classifier, or opening. Known pending remains encumbered across the period boundary and incomplete coverage; unobserved pending is not invented. Settlement and exclusions use the incumbent transaction rules. The waterfall then continues with required dated future-cost set-asides attributed from that same feasibility walk, extra debt through `Forecast.debtPriority` only from proven true surplus, then owner-marked optional residual. The owner-stated 2026-08-24 policy puts true-surplus debt repayment before optional future costs and additional discretionary cash accumulation; among eligible revolving cards and the HELOC, highest known interest rate wins. Equal or unavailable rates fail closed because no owner tie-breaker exists. Required or bounded-flex amounts with no exact date stay unresolved: no fabricated date, no mandatory contribution, no silent demotion to optional residual, and no release of leftover cash to extra debt or optional residual unless owner-authorized semantics already mark the item optional or otherwise releasable. Obligation items are the same joint-cash events `expandEvents` emits for this payday period: `upcoming` when the scheduled date is on or after as-of; `unverified` when that date has passed and settlement is not proven. `requiredDebtPayments` is the debt-payment subset of those incumbent obligation events; it remains distinct from surplus principal. `representedEvents` (and a live overlay `priorAsOf` window) omit a represented occurrence from the reserve — they do not invent a paid/unpaid tracker, and a passed date is not confirmed unpaid. Essential items are the incumbent `budgetBreakdown` essential categories (owner target, then current-regime, then historical), scaled to this payday period; an `every-other-seaspan` owner cadence uses the same `paydayCyclePlanned` amount as Household Budget on the current `spendingCycle` (ON = the standing $N hold, OFF = $0), and a category with `plannedPayday` uses that same `paydayCyclePlanned` amount when it is not null (Groceries $450 per Seaspan cycle), rather than a remaining-days smear of the monthly equivalent; dated bills already in obligations are not added again. Partial essential cash is held as an unattributed pool: there is no owner policy for which essential category loses first. Partial obligation cash is likewise an unattributed pool: there is no owner policy for which required bill is paid first. Per-item allocation equals each required amount only when the whole bucket is funded, and is zero when none is funded. Pages render every obligation item and every essential requirement line Forecast returns, plus the weekly-cap spend permission separately from the essential reserve. A dated opening is labelled from its as-of date; the page does not call it Now. A live overlay may be labelled live from that same authoritative financial date and does not infer wall-clock freshness. Credit and unapproved borrowing are not cash. Allocated dollars plus unallocated remainder equal available resources. `Forecast.recommend` attaches this same result; the page does not compute it |
| Plan payday operating sheet — the default Plan first screen | Presentation only, in `public/plan.js`, of one `Forecast.recommend` result. When `liveOverlay.operatingPlan` is unavailable, that page renders one compact unavailable state (primary Current plan unavailable, dated/non-current last trusted opening, independently valid `needsDate` items) instead of the current payday waterfall; the trusted waterfall is unchanged. The default print is `defaultView.calendarPeriods`: two independently visible payday-cycle waterfalls derived from the incumbent `Forecast.spendingCycle` (This Pay Period = current Seaspan payday through the day before the next Seaspan payday; Next Pay Period = that next payday through the day before the following one). `Forecast.recommend` also publishes `payPeriodViews` (those two rows, the completed `pastPeriodViews` oldest first, then further full Seaspan cycles from the same `calendarPeriodWaterfalls` printer) and `payPeriodTimeline` (index, count, `through`, `horizonReason`, Dale-income authority end). `calendarPeriods` stays exactly those two objects, so Show both does not lengthen. `nextPeriodView` remains the More views lookahead ten-block and is not a timeline authority; the timeline next row is `calendarPeriods` Next Pay Period. Further cycles stop at the earlier of the knowledge horizon and the owner-approved 2027 estimated payroll regime end (Dale, 2026-09-25 7:43 PM PT: "Use the 2027 estimated payroll for 2027 pay periods, marked as estimated."); `Forecast.projectedDalePayroll` is the one projected source, and that estimate is stamped on future, next, and current Budget rows for Dale dates from 2027-01-01 until observed or represented evidence supersedes that occurrence. It is not applied to past rows or `nextPeriodView`. When the regime is unavailable, current and next keep the incumbent amount and further 2027 cycles are omitted. The 2026 net is not carried into an unevidenced 2027 row. A 2027 row can shift when the actual deposit posts. `incomeRegimeBoundary` stays 2026-12-31. When the regime is unavailable the timeline stops at that boundary. Road Ahead stage, trajectory, and month-close values are not read. Per-row extra-debt and big-purchase amounts are not summed. On a role-future window, an occurrence dated after the Forecast financial date stays in the period and in the bill load. Its household-facing status stays planned, its settlement is not represented, Paid bills this period excludes it, and Remaining bills to pay includes its amount. Past and current rows keep the incumbent status. Paid bills and Remaining bills can change on Budget's Next Pay Period because it is the same object; the amount, period bill load, and Balance After Deductions do not. The owner-approved Other target is $450 every pay period beginning Sep 25, 2026; current/future hold is max(target, eligible actual) once, with unused target reserved. Earlier actual-only periods and unavailable history are retained. The former $800 monthly and $400 future-only fields are bounded retired configuration, not co-active amounts. Calendar 1st–15th / 16th–month-end halves are not the household operating Pay Periods (superseded). Extra income dates do not spawn extra sections. A picker may print `nextPeriodView`, one `weekViews` row, one `pastPeriodViews` completed Seaspan cycle, or `paydayCarryoverTrend` instead; the page does not subtract leftover or invent a week. Completed-period dates follow `Forecast.spendingCycle`. Payday carryover is spendable cash remaining at the next payday morning — a recorded `paydaySnapshot`, payday-morning cash when as-of is that payday, or a completeness-proven `establishPaydaySnapshot` walk — and is not salary, Other Income, new earnings, or projected leftover. `public/plan.js` prints that Forecast field when known and does not reconstruct it. `paydayCarryoverTrend` is the same carryover values in chronological order; unknown periods stay unknown or omitted, a genuine $0 stays $0, a known negative prints as a deficit (left of center) rather than a leftover-direction bar, and the page does not recalculate carryover. Completed-period income and bill rows are received/PAID only from independent historical settlement (`represented` / observed `actual`); date-passed or inside-opening on today's recurring plan is not historical settlement, and those unproven scheduled amounts render as planned/unknown rather than completed actuals. When the supplied actuals packet covers a completed window, `pastPeriodViews[].householdBudget` publishes classified Spent actuals for that window and the completed sheet prints them; incomplete coverage omits spent rather than inventing it. Live Current Balance stays on the current operating print and is omitted from a completed-period view. Live Current Balance is posted household chequing cash (`Forecast.postedHouseholdChequingCash` published as `defaultView.liveCurrentBalance` / `paydayAllocation.liveCurrentBalance`): Chequing A / BILLS ACCOUNT plus Chequing B / WEEKLY SPENDING from `plan.startingCash.breakdown`. Live Current Balance and Forecast walk / paydayAllocation spendable opening (`startingCashAmount`) share that chequing-only pool. Designated `savings` / EMERGENCY SAVING stays on the breakdown as reserve evidence and is not ordinary spendable opening. Current Balance is not savings, not TENNIS INCOME / `amanda-debt-payments`, never overdraft, never `paydayAllocation.available` when that figure already includes same-day arriving income, never `chequingAvailability`, never every Lunch Money cash-type account, and never a BILLS-ACCOUNT-minus-posted-spend rewrite. It is printed outside the payday snapshot so the household does not read it as the first line of the payday equation. The Current Balance date is the incumbent provider cash-observation date (`observedAsOf` / `evidenceDate`), never Atlas `fetchedAt`, never a hardcoded Lunch Money hour, and never the browser clock. This Pay Period is the frozen payday snapshot: opening is a recorded `plan.opening.paydaySnapshot` whose `asOf` and `periodStart` are that payday when that snapshot records a finite numeric opening, else payday-morning cash when Forecast as-of is that payday and the live opening has not already advanced, else the non-live dated Forecast opening when that opening's `asOf` is this Forecast start (cutover springboard), else `Forecast.establishPaydaySnapshot` walking that same non-live dated opening through the morning of this payday only when the interval is complete enough to reconcile every chequing-pool spendable movement that can change that balance (explicit complete `paydayGapCash` coverage of the household-cash gap; designated `savings` / EMERGENCY SAVING movements stay reserve evidence and do not enter the reconstructed spendable opening; scheduled-only reconstruction is not completeness; no weekly-variable spend, no reserved-daily drain, and not today's live cash added backwards). If completeness cannot be proven, the payday opening fails closed. Payday balance remains the income identity and does not inherit that withhold. A live overlay that advanced as-of (`priorAsOf`) does not make today's cash the payday opening, including when that live as-of is the payday calendar date; live-plan retains the Forecast-established snapshot on the in-memory opening only when that snapshot is recorded or the gap walk is cash-complete, so an incomplete reconstruction is not kept after starting cash is overlaid. A null, empty, or non-numeric snapshot opening is rejected rather than coerced to $0; without one of those authorities the payday opening fails closed rather than inventing history. Payday balance still publishes the period income identity. Received income remains a visible period row; `alreadyInCash` is settlement/status against live cash and does not drop that row from the snapshot sum. Payday balance (`calendarPeriods[].available`) is the pay-period income identity: Dale salary + Amanda salary + recognized Other Income (`incomeTotal`). The frozen payday opening and live Current Balance stay separate facts and are not terms in that allocation waterfall. Settlement status may mark a salary not-relied-upon without erasing it from Payday balance. Owner policy 2026-09-11: on a Seaspan payday (household financial date in America/Vancouver), Dale's Seaspan salary is relied upon for planning from 00:00 PT that day even when Lunch Money has not posted the deposit — Forecast recognition, not represented settlement and not a deposit invent. Amanda Tennis BC salary stays unconfirmed/arriving until confirmed settlement evidence; her payday date alone does not make it received or relied-upon. Child benefit is unchanged. Next Pay Period is future and opens from This Pay Period's projected ending, or from the already-run walk's start-of-day cash on that next payday when This Pay Period has no recorded opening, then adds that next cycle's income once. The $500 `targetBuffer` remains the weekly-cap / extra-debt / purchase-room risk floor and is not subtracted from payday opening or Payday balance. A bill or income occurrence on the next Seaspan payday belongs to Next Pay Period. Next-period Current Balance is the already-run `recommend.sim` start-of-day cash on the next Forecast payday plus that day's income. A week view's Current Balance is that simulated week's opening. Each calendar waterfall prints Forecast opening when that opening is known (carried-forward cash, not income), including the active period, income (its own block, ending in Payday balance from `calendarPeriods[].available` = `incomeTotal`), that half's bills (name, amount, date, paying account, status), total bills this period (paid+unpaid, equal to the displayed rows), paid bills this period, and remaining bills to pay (pending/upcoming/overdue only) are settlement disclosure; leftover after bills subtracts the authoritative period bill load assigned against the frozen payday snapshot — unpaid rows plus represented PAID rows that are not already inside that opening — not remaining-only and not a second deduction of a paid bill already inside the opening cash, household budget on the active waterfall is the same Seaspan 14-day payday spending cycle (`Forecast.spendingCycle`) as the operating Pay Period: Groceries $450/week = $900 per cycle, Fuel $325, Dog food $100 once per calendar month, assigned to the first Seaspan pay period beginning in that month (later Seaspan starts in the same YYYY-MM $0; not prorated), Eating out $200, Dale $150, Amanda $150 (always shown); Other spend uses the owner-approved `other-spend.plannedPayday` $450 target from Sep 25, 2026 onward; Forecast / Road Ahead / trajectory use the incumbent target conversion via `budgetBreakdown`, and Budget calendar holds that dated target or eligible actual, whichever is higher, once; Budget calendar still prints Other spending confirmation actuals (`other-spending`) when recon exists; Household currently has no planned Household Budget payday hold (owner-instructed 2026-09-04; the 2026-08-31 $37.50 per-cycle target is retired; explicit $0 monthly planning baseline so historical Household actuals do not re-enter required essentials); the 2026-08-31 payday-lock subtotal is $1,825.00 when that month's Dog food is assigned, else $1,725.00; spent is overlay actuals in that cycle through as-of (Aug 16–27 does not leak into the Aug 28 cycle); a 1:1 pending+posted surface twin already flagged `pendingPostedDuplicate` keeps both rows on Forecast recon as unresolved possible replacement and counts only the posted side as confirmed spent — that flag is not directed identity and does not collapse the pending authorization; the household-facing Spent drill-down in `public/plan.js` omits a pending recon row already marked `pendingPostedDuplicate` and does not infer replacement; Surrey Meat is Dog food never Groceries; Walmart, Meridian Farm and Iron Butcher (Dale 2026-09-02) are Groceries; Cursor (Dale 2026-09-02) is Dale guilt-free; Amazon merchant identity plus canonical `travelvisa` (Dale 2026-09-03) is Amanda guilt-free, never Other, never a Prime bill, and never Amanda on `mbna` or another card; PITT MEADOWS CE / PITTMEADOWSCE (Dale 2026-09-02) is Fuel, never Other, and no other Pitt Meadows merchant inherits it; the exact payee CAN TIRE MC (Dale 2026-09-02) is the Canadian Tire Mastercard payment — card-payment, never Household Budget Spent, never Other, with amount and date no part of the identity; Eating out is Restaurants + Fast Food + Food Delivery; ordinary Canadian Tire retail is not Household and is not the card payment; 7-Eleven is not confirmed Fuel without tx-level fuel evidence; the incumbent `needsConfirmation` / unclassified residual is Other spending (`spent` only, no planned reserve), meaning current-cycle household spend that Forecast cannot yet safely assign after the incumbent known account, financial-identity, merchant, owner, and category rules, not a total of every dollar outside those rows and not a catch-all for already-known transactions; an eligible debit whose Lunch Money category label is exactly Uncategorised joins that same Other spending actual once, reduces the household remainder dollar-for-dollar, and does not create a planned reserve, while named non-calendar categories stay omitted; each row's displayed spent equals the confirmed recon sum (a pending `pendingPostedDuplicate` row is omitted from that sum and from the household-facing drill-down); remaining may be negative as overspend disclosure; owner-instructed 2026-09-04, a planned Household Budget category reserves at least its planned amount (`hold` = max(planned, spent) = planned + overspend above plan), actual spending fulfills that reserve up to plan and only actuals above plan increase the payday deduction, and Other Spending actual is deducted once with no `max(planned, actual)` because it has no planned reserve; classification must not count the same transaction in Other Spending and a planned category; remaining-only leftover and planned-plus-actual are both wrong. The Household Budget section prints Forecast `calendarPeriods[].budgetHold` as Household Budget Total; the page does not recompute that deduction. Balance after bills minus that printed total equals Predicted Ending Balance. Owner 2026-09-21: leftover after household budget is Predicted Ending Balance (`opening + incomeAdded − period bill load − Household Budget hold`), the living current-pay-period remaining-household-money identity, not payday-income remainder and not live Current Balance. It fails closed when the payday-boundary opening is unknown. Forecast publishes `operatingCashExplanation` on the active calendar period and `defaultView`: leftover identity is predicted-ending-balance (`afterHouseholdBudget` / `predictedEndingBalance`); operating-cash identity is posted household chequing (`liveCurrentBalance`); BILLS cash identity is the incumbent posted `chequing-a` / BILLS ACCOUNT breakdown row. Those are three different contracts. Leftover is not rewritten to equal Current Balance or BILLS cash, leftover minus BILLS is not published as missing money, and Bills → Savings is location of household money, not consumption. Proven `householdInternalMovements` whose both legs fall in the active period (`period.start` through the financial as-of, or period end when that is earlier) carry `operatingCashEffect` `stays-in-operating-cash` / `leaves-operating-cash` / `enters-operating-cash` (BILLS↔WEEKLY stays in Current Balance; chequing→designated savings leaves it; savings→chequing enters it) and, when a leg is BILLS ACCOUNT, `billsLocationEffect` `leaves-bills` / `enters-bills`, without becoming leftover income, leftover spending, a savings-purpose assignment, or a BILLS cash walk. Unproven or non-BILLS pairs do not receive BILLS-location meaning. Undated or out-of-window pairs are omitted rather than attributed to this payday; pairing itself is unchanged. `public/plan.js` reprints the packet after Predicted Ending Balance and does not pair transfers or subtract leftover from Current Balance or from BILLS cash. Extra-debt / big-purchase / ending rows stay off this print, except for the narrowly authorized named planned-cost savings contributions in the [Budget savings-display amendment](#budget-savings-display-amendment--owner-direction-2026-09-30) below. The Plan print’s last waterfall step remains Predicted Ending Balance. The usable Plan does not print `data-operating-warnings` after that row (owner instruction 2026-09-09): no feasible-cap, unfunded-shortfall, remaining-coverage, debt-risk, or refresh-attention copy on this surface. Payday balance lives in the Income block; there is no second Balance after payday row. Forecast still computes, on each period and unprinted, extra credit-card repayment above the minimum via `debtPriority` — waiting until this Household Budget reserve and remaining bills are protected and without taking leftover below `plan.defaults.targetBuffer` — other revolving cards, big-purchase allocation from `majorPlans`, and the projected ending the next pay period opens from; those rows are not on the household Plan surface (owner instruction 2026-09-03), subject only to that named savings-contribution exception. The Planning page prints the `majorPlans` verdicts; the Credit page prints each debt's facts and next required payment and, by owner instruction, no payoff order or extra-payment instruction, so the extra credit-card repayment amount and target remain off every household surface except the week / next-period lookahead ten-block behind More views. Paid bills stay listed as PAID and are not deducted again. Payday-window assignment uses the authoritative scheduled due (monthly `day`, once-row sibling cadence), not the bank post date and not a fail-closed posting-unknown window date; weekend posting delay does not move a bill into a different payday window. An unresolved once cash obligation that `expandEvents` still carries after its scheduled due stays reserved in This Pay Period until represented, settled, or cancelled; the printed date remains that scheduled due and is not rewritten to the current payday. Remaining-bills includes pending, upcoming, and overdue only. Income never lands in remaining-bills. Posted income already inside live current cash is visible and is not added again. Other Income is a first-class Forecast calendar-period group (`calendarPeriods[].otherIncome`): genuine irregular household-resource inflows in that payday window that are not Dale payroll, Amanda Tennis BC salary, a named recurring `plan.income` stream, transfers, card payments, TENNIS INCOME staging, spend-reversal refunds, or a cash flow already represented by another event. A household-cash TD ATM deposit (`ATM DEP`) may enter that group even when Lunch Money labels it Payment, Transfer, when Forecast identity evidence shows it is not a TFR-(TO|FR) internal-transfer leg; the subsequent TFR-FR into another household-cash account is still excluded. An otherwise ambiguous household-cash credit explicitly categorized Income in Lunch Money is a manual correction path into the same group, and cannot turn an internal-transfer identity or already-modeled payroll into new household resources. Constituent items are expandable presentation of that Forecast list; `public/plan.js` does not classify or total them. Expected other-income `plan.income` once-rows stay arriving until represented or uniquely reconciled to one unmatched observed deposit in the same window; the pair is counted once. `calendarPeriods[].incomeTotal` is the sum of displayed period income rows. `incomeAdded` remains the settlement-qualified increment (period income not already inside the payday opening and not marked not-relied-upon). Payday balance publishes `incomeTotal`, not `opening + incomeAdded`. Coaching leftover remains gravy when it arrives and is not a recurring Forecast income line (Q1). HELOC cash minimum is the printed cash obligation and is not counted with capitalised interest as two cash hits. Dated card-paid Bell Mobility on the 15th prints in the one Seaspan payday window that contains that planning day and is reserved gravity, not a BILLS ACCOUNT / chequing withdrawal. A remaining `needsDate` bill still prints outside both remaining-bills totals and does not invent a day. `thisPayday` remains payday-date events only. Lookahead and week bills stay that span's `expandEvents` with Forecast settlement. Next-period and week leftover use the same leftover identity on that span's unpaid joint-cash bills and owner-target hold (7-day scale for a week, that period's days for the next payday); extra and big-purchase set-aside stay $0 on those spans because they are this-payday surplus decisions. Household budget does not invent Dale/Amanda rows. After a lookahead or week ten-block, that view also prints `budgetDigest`: each existing owner-target category, `spent $X of $Y`, where spent is classified live overlay actuals in that span and Y is the owner-target monthly scaled to that span's days (not leftover remaining-cap, not the unscaled monthly target). Incomplete actuals or a spending-history as-of behind the view as-of are kitchen-counter words; remainingClaim codes stay off the page. The page does not subtract leftover. Glance movements print money in as + and money out as − from Forecast `movement` fields without flipping leftover math. Weekly cap, allocation sheet, and 13-week diagnostics stay folded. Forecast still computes infeasible mode, funding shortfall, remaining-claim, and `paydayAllocation.risks`; `weeklyCapView` still composes that copy for folded diagnostics. The usable Plan does not print compact `data-operating-warnings` after Predicted Ending Balance. The large refresh-trust card stays off the usable Plan; it remains on the fail-closed unavailable surface. Distinct from `Forecast.nextMove` / `plan.actions`. Not a second planner, payday engine, goals engine, or freshness calculator |
| Current-period action — planned, actual, remaining, payday vs between-paydays | `Forecast.currentPeriodAction`, classifying evidence with `Forecast.classifyCurrentPeriodTransaction`. Mode follows the incumbent Seaspan `Forecast.spendingCycle` on the authoritative financial as-of, not the browser clock and not any income ≥ $1000. Amanda salary and child benefit do not start payday mode. Represented same-day Seaspan payroll does not exit payday mode. Bills reuse `expandEvents` and `representedEvents`: represented is paid, a past scheduled date without that proof is unverified (not unpaid), a later date before the next payday is still due. `thisPayday` is that payday date (as-of when today is payday, otherwise the previous payday). `thisPaydayPaid` is represented inflows and paid bills on that payday date only, including a represented card min whose posting date is that payday. `thisPaydayDue` is unpaid this-payday remaining bills from `paydayAllocation.obligations`, omitting carried once-rows dated before this payday. Glance rows carry a `movement` signed for household cash flow (in +, out −) without changing leftover or waterfall math. `Forecast.currentPeriodObligationStates` exposes those same bill settlement states without computing `recommend` or `paydayAllocation`. Represented settlement proves the occurrence, not that the scheduled amount was the observed debit; `actual` is the identified transaction amount after identity, or unavailable. Variable remaining uses the same `budgetBreakdown` categories and `from` aliases as the payday essential hold. Observed unresolved pending constrains remaining even when the pending universe is incomplete; that status is qualified, not a reason to drop known pending. A pending row already flagged `pendingPostedDuplicate` is unresolved possible replacement of its posted mate: the posted amount is the confirmed household spend, and that pending does not constrain remaining a second time while remaining recon-visible pending exposure. `opts.currentPeriodActuals` is provider-neutral evidence from the read-only observer; Forecast does not read Lunch Money API fields. A uniquely proven TD `TFR-(TO|FR)` pair between household cash locations (`chequing-a` / BILLS, `chequing-b` / WEEKLY, designated `savings` / EMERGENCY SAVING) is one `Forecast.householdInternalMovements` economic movement with source and destination; `Forecast.currentPeriodAction` publishes that list and `Forecast.classifyCurrentPeriodTransaction` classifies each proven leg as `internal-movement`. The movement is not household income, not household consumption / Other Spending, not newly created cash, and not a financial loss. Overlay observation stamps `tfrReference` / `tfrDirection` before merchant strip so pairing survives sanitization. Unpaired or ambiguous transfer-looking transactions (including SEND E-TFR, TFR-TO C/C, Tennis INCOME, HELOC, and SAVINGS-DONT TOUCH counterparts) stay fail-closed under the incumbent classifier and are not promoted to proven-internal status. Pages do not pair transfers. Transfers, card payments, income, business-excluded, uniquely represented bills, explicitly `household-external` amounts, and issuer-posted revolving-card finance charges (purchase interest, `INTEREST CHARGE -PURCHASE`, cash-advance interest, BT interest, and the Lunch Money `Interest charge` category on a revolving card) are not household category spending — they are debt/interest cost, excluded from Household Budget, Other Spending, merchant categories, and payday household-spend, and they do not move Current Balance (posted chequing only). Card debt, utilisation, and interest reporting keep them. Owner-confirmed merchant identities and the Amazon + `travelvisa` standing owner rule classify before Other. Unmapped provider accounts are not household-external: an unresolved current-period account makes remaining unavailable. A transaction is classified once. Stale, period-incomplete, truncated, or unresolved-account posted-transaction coverage fails closed and does not publish a precise remaining figure. `remainingClaim` is provider transaction-coverage completeness (`precise` / `posted-only` / `unavailable`), not named-category remaining precision. Named remaining is precise only when `categoryRemainingClaim` is `precise`: coverage is complete and every current-period household-spend transaction is assigned to a trusted named Atlas category. Unclassified or unmapped-label household spend keeps remaining visible as observed and does not publish a precise named-remaining claim. Transfers, card payments, proven household-internal movements, income, business-excluded, household-external amounts, and revolving-card finance charges do not by themselves degrade category remaining precision. Historical actuals remain generated `public/periods.json`. Not a second planner, settler, budget taxonomy, or transaction store. `public/plan.js` holds the wording only |
| Card purchase coverage and payment allocations | `Forecast.visaPaymentReconciliation` is the single evidence-qualified ledger for mapped revolving cards; the historical API name is retained. Native CAD purchases reserve Bills cash immediately and retain original spending classification once. A unique pending revolving identity match of a still-due card-paid bill is that bill, not uncovered card spend and not a second Budget deduction; it is not represented settlement. Uncovered cents carry across payments and periods. A confirmed opening and explicit allocation records link each payment to posted, unique Bills-debit/card-credit references; no amount/date/merchant window infers purpose or an excess payment. Refunds and reversals require explicit links. Unknown opening, units, identity, pairing or intent withhold precise available-cash/funding claims, preserving actual bank cash, debt and known scheduled facts. The proposed `plan.cardPurchaseCoverage` contract is exercised only by synthetic fixtures; no production opening or allocation is invented. Existing `cardMinimumNeedsConfirmation` and exact `plan.opening.representedEvents` remain the issuer/owner settlement boundary. Coverage never satisfies a minimum itself. Observer supplies sanitized references and unit diagnostics, Forecast protects the same cash path, and Budget prints that ledger through `Forecast.visaPaymentPublication` and `BillDetail.visaPaymentsHtml`. The publication function only removes identity fields; it does not allocate. No new expense, debt, observer or allocation store. See `docs/proof/CARD_PURCHASE_COVERAGE.md` |
| Funding sequence among future commitments | `Forecast.fundingSequence`, from unsettled `plan.commitments`. Presentation order only: required, then bounded-flex, then optional. Protected rows then use dated timing, certainty, and owner-stated `priority`. Optional residual ranking is owner-stated `priority` first, then date and certainty — an earlier optional item does not outrank a later one the owner ranked higher. Feasibility is simultaneous, not this list consumed as a serial leftover pool. No commitment id is special. Completing or disabling one item drops it from the sequence and releases future contribution capacity; encumbered principal is not free cash |
| Major future-plan verdicts — ON TRACK / AT RISK / FUNDING GAP | `Forecast.majorPlans`. ON TRACK means the authoritative/base case is jointly feasible, with a dollar margin. AT RISK is an explicit protected uncertainty case (a range ceiling) failing while the base case remains feasible. FUNDING GAP is authoritative infeasibility on this path, with a dollar gap. A dated range is tested against surplus on its stated date, not against leftover after later income, and remains encumbered from the point it is funded or due until settlement or authorized release. An overdue protected point amount or overdue dated-range floor is tested against as-of surplus, not leftover after later income, keeps its original scheduled date, and is aggregated with every other overdue protected floor so the same current dollar cannot fund two of them. An overdue range stays a range: min/max are not collapsed, and a missing pre-as-of simulation day is not treated as a full-floor gap when current cash covers the floor. Dated-range margin is `surplus − due.floor` (base) and `surplus − due.ceiling` (uncertainty), not the surplus itself: ON TRACK exposes the nonnegative uncertainty margin, AT RISK the positive base margin with the ceiling shortfall, FUNDING GAP a negative base margin. Optional residual is taken after all still-encumbered protected principal. Optional items contribute nothing to protected safe-to-spend but keep their actual point or range target for residual funding, margin/gap, and owner-priority ranking. Ordinary transactions and budget categories are not graded. A range is not collapsed to its floor. Flexible items may be marked deferred; a non-flexible date is never rewritten |
| Planned-debt consequences when borrowing is explicitly permitted | `Forecast.plannedDebt`. Default is `permitted: false` and `borrowed: 0`. A purpose-specific draw requires named purposes (`plannedDebtPurposes`); a generic allow flag does not finance every gap. An owner-authorized amount (`plannedDebtAmounts`) may finance a named purpose even when the cash path is already feasible; a cash shortfall is one reason to borrow, not the only one. Capacity uses `openingBalance` (posted plus pending); unknown pending is not usable room. The draw is capped by named-facility capacity (and an owner `plannedDebtMax` when supplied), inserted into the same Forecast cash projection and `Forecast.projectDebts` walk as proceeds, interest, future balance, and required repayment cash flows, and is feasible only when a repayment cadence is supplied, that post-financing walk still holds the protected plan under the same predicate as the weekly search (buffer path, overdue as-of constraint, still-encumbered principal, and every still-future dated-reserve deadline), and the named facility never crosses its limit on the walk — not only that the ending balance is under. Automatic draws for protected overdue purposes consume that protected overdue aggregate remaining once, but only up to the base floors of the named auto-eligible protected overdue purposes — naming one purpose does not authorize financing another. An earlier explicit `plannedDebtAmounts` draw on the same protected overdue pool reduces the shared remainder before any auto-sized draw is added. Each auto draw is also capped by that named purpose's own base floor. Optional overdue residual purposes keep independent remaining and are not collapsed into that shared protected gap. Q19 HELOC cash treatment is not resolved here |
| Income dependency deadline — when a modelled income becomes required to preserve the buffer | `Forecast.incomeDeadline`. Amanda's two owner-confirmed Tennis BC salary streams are composed by `Forecast.amandaHouseholdIncomeDeadline`, which zeros both streams and reports their combined monthly amount |
| Next due — which named cash obligation the household owes soonest | `Forecast.nextDue`, from `Forecast.expandEvents`. Names one event; two obligations on one day do not become a day-total. Distinct from `Forecast.nextPaymentOut`. `public/deepdive.js` holds the wording only |
| Next payment out — cash leaving on the next outflow date of the projection | `Forecast.nextPaymentOut`, from the same `expandEvents` stream (`sim.events` on the Plan page). Names the day and sums every cash outflow on it; two registrations on one day are one payment as far as the account is concerned. Distinct from `Forecast.nextDue`, which names one obligation from that stream. `public/plan.js` holds the wording and the 3-day tile tone only |
| Unallocated ending cash — the remainder after the target buffer and windowed reserves, and whether that is free cash | `Forecast.unallocatedCash`, from `sim.ending`, `sim.buffer`, `budget.reserveMonthly` and `plan.windowDays`. Converts the monthly reserve over the window with the calendar month `365.25 / 12`, subtracts buffer and reserves, and decides the leftover verdict on the published cent. `public/plan.js` holds the wording only |
| Compact snapshot — secured debt total, monthly interest across every facility, and HELOC month-on-month direction | `Forecast.compactSnapshot`, from the debt records' posted `balance` / `annualInterest` / `secured` and `helocHistory`. `balance` is the posted opening; pending is added only through `openingBalance`. A month of interest is a twelfth of the recorded annual figure. The HELOC verdict is the posted `debts.heloc` opening minus the last monthly `helocHistory` observation; `helocHistory` is not a second current balance. The verdict follows the published whole-dollar delta, so a move that prints `$0` is unchanged rather than growth. `public/plan.js` holds the wording and the sign only |
| Publication totals — Deep Dive headline total debt, annual interest and credit left; Records net-worth lines; the income footer; the commitments total; the lacrosse verified total; and the HELOC limit the history chart draws | `Forecast.publicationTotals`, from posted `debts` balances and `annualInterest`, `assets` values (cash rows derive from `plan.startingCash` via a `cash` id; non-cash rows keep their own value), `income` line totals over `incomeCaptureMonths` (the historical income evidence window, not a code constant and not `periods.json` spending buckets), unsettled `plan.commitments` (the one home for known major future costs; open ranges contribute no point amount), `lacrosse.sources`, the HELOC debt `limit`, and `Forecast.utilisation` for headroom. Recurring historical-income monthly figures are `round(total / incomeCaptureMonths)`; a stored `perMonth: null` keeps a one-off from becoming recurring. The same twelfth `compactSnapshot` uses. Pages hold the wording only |
| Deep Dive derived totals — held-elsewhere grouping, period spending average, discretionary share, avoidable fees, Cash Back Visa cycle fit, the mortgage's monthly interest, and the published HELOC history/trend | `Forecast.deepDive`, from `plan.startingCash.heldElsewhere` values and `Forecast.startingCashAmount` (Chequing A+B; designated Savings remains reserve evidence), the selected `periods` entry, `interestCheck` rows, the `cashback` / `mortgage` / `heloc` debt records, and `helocHistory`. The card rate is the Cash Back Visa `rate`; a cycle is off when `|eff − rate| > 4` percentage points, the incumbent band. Mortgage monthly interest is `monthOfAnnual` on that debt's `annualInterest` — the same twelfth `compactSnapshot` uses. Discretionary share counts only rows whose published spend type is `discretionary`; a mixed essential/discretionary source category publishes as `unknown` and is not counted as either class. The published HELOC series is the stored monthly observations plus the current `debts.heloc` opening. The month-on-month delta is the same `debts.heloc` minus last observation identity `compactSnapshot` uses; Deep Dive classifies that delta, and the since-paydown delta, by the published cent (`money2`) so a sub-dollar move cannot read unchanged beside two different displayed balances. The compact Plan tile keeps whole-dollar classification. `public/deepdive.js` holds the wording only |
| Plan phase titles and the risk list — which heading each 30-day block gets, which risks appear, and the figures inside them | `Forecast.planPhases`, from the `recommend` and `projectDebts` results plus the already-run `amandaHouseholdIncomeDeadline`, `counterfactuals` and `budgetBreakdown`. Over-limit-today and the HELOC crossing are the same helpers `Forecast.mission` uses. The Amanda window impact is the incumbent `amount × 3`. The HELOC draw is `drawnOn(funding, 'heloc')`, the same sum the HELOC alternative prices. `public/plan.js` holds the wording only |
| Coupled cash-and-debt walk | `Forecast.projectDebts`. Past unresolved once cash obligations are applied at this opening via the same `cashWalkDate` `simulate` uses; `obligationAbsorbed` still keys the original scheduled date. A represented prepaid joint-cash obligation payment (named on `representedEvents`, still upcoming relative to this start) is omitted from the cash calendar so it is not reserved again; this walk still applies that same scheduled payment to the named debt on a dated opening. A live-advanced opening overlays posted debt, so those names stay omitted from the debt walk. Cash-only represented bills do not move debt. The first HELOC limit-crossing date is this walk's `crossings` result; `plan.assumptions` and `plan.nextDollar` do not store a matching calendar day. Pages format that date; they do not choose it |
| Credit page accounts — one debt record beside its headroom and its next required payment | `Forecast.creditAccounts`, composing the `debts` records with `Forecast.utilisation` (pending included; unknown pending withholds headroom) and the first `Forecast.expandEvents` payment occurrence for that `debtId` on or after the financial as-of over `knowledgeHorizon`. Order is record shape — secured term debt, secured revolving, then unsecured cards, data order within each — not a payoff ranking. A capitalising facility carries two separate facts: `nextCapitalise` (the non-cash interest event) and `nextCashMinimum` from `Forecast.capitalisingCashMinimumOccurrences`, the one rule `expandEvents` uses for the Required-debt cash obligation and the Plan bills list also prints; they are never merged into one payment. A stored `nextDue` on the debt record is not read. An absent fact stays `null`; `public/credit.js` prints Unknown, never $0, 0% or nothing due. Not a payoff modeller, not a second utilisation, not a second calendar |
| Planning page — Forecast Road Ahead | Presentation only, in `public/planning.js`. Household dock label is **Forecast**. The dedicated planned-spending list is the Plan spend page. Known future costs: of `majorPlans`, `paydayAllocation` (`futureCosts` / `optional` / `unresolved`) and `knowledge` from the same `Forecast.recommend` call the Plan page and the assistant packet make. Rows print in `majorPlans` order; verdict, remaining, range or point, `when`, flexibility, confidence, `deferred`, and any `allocated` / `projectedByDeadline` are copied. The only aggregate is `knowledge.encumbered`, printed as Forecast's protected floor with ranges at their low end. No saved balance is invented. When the current operating plan is unavailable the page withholds verdicts exactly as Plan does. The household-facing first screen **Your Financial Road Ahead** composes that same `Forecast.baselineTrajectory` call only: lead copy from the first forward negative `stage3.result` when Forecast publishes one, otherwise the first forward `pressure.signals` mechanical fact (no invented sustainable/safe/healthy verdict, RYG, min-cash, affordability, or recommendation cards); a Month / Pay period timeline of published `stage3` projected results; and a selected-period three-stage funding progression, with progressive disclosure for future costs, the full monthly cash/debt table, all pressure signals, and debt direction. On Road Ahead the page also accepts one explicit caller-supplied eligible debt id and whole-cent additional payment amount and calls `Forecast.baselineTrajectoryScenario` only — reprinting Baseline vs Scenario projected cash (published close), named-debt ending/paid/interest, and Forecast `delta` when those walks establish them; baseline timeline and stage3 reprints stay on `Forecast.baselineTrajectory` and are not replaced by scenario output; nothing is inferred, ranked, persisted, or written. The same page also reprints `Forecast.baselineTrajectory` monthly income, month-end cash, and coupled debt marks — status, amounts, and unavailable reasons only; every horizon month prints, including 2027 months Forecast marks estimated or unavailable with notes rather than omitting them or walking carried 2026 net. For a household-selected period from that same call it reprints `stage1` / `stage2` / `stage3` funding — Normal life, After planned spending, After debt strategy — in Month view from `months[]` or Pay period view from `payPeriods[]` (same baseline walk, two Forecast-published granularities; a pay-period row whose published start is after its Seaspan payday is remaining through next payday — the clipped as-of residual of that cycle — not Budget’s full This Pay Period; pages reprint `displayIdentity`, walk dates, and `cycleRangeLabel` and do not relabel that residual This Pay Period), copying Forecast component totals and results when present, preserving calculated vs estimated trust, and failing closed with Forecast reasons when a stage is unavailable (never $0 or implied surplus); no page-side stage arithmetic. The household Road Ahead surplus or deficit is that period's `stage3.result` under identity `standalone-period-surplus-deficit` (`priorPeriodSurplus: excluded`): income occurring in the month or Seaspan pay period, minus known joint-cash bills, required debt obligations, expected normal spending, named planned commitments, yearly card-paid bills in that period (once), and genuinely scheduled extra debt in that same period. A positive result is surplus that period can set aside. A negative result is funding required before that period arrives. Earlier surplus is not applied to erase a later deficit. The page reprints Forecast's phrase for that identity and does not add prior-period surplus or substitute `cash.amount`. `cash.amount` remains the cumulative walk close (`identity: cumulative-walk-close`, `roadAheadFunding: false`) and is not this funding result. From the same `Forecast.baselineTrajectory` call it reprints `pressure.signals` when `pressure.status === 'ready'` — plain-language labels for closed signal kinds, Forecast date/month/amount/trust/id/asOf when present, Forecast order preserved, and under each signal copies `signal.attribution` when Forecast published it (ready: attributed change, drivers, and facts in Forecast order with plain household labels for closed driver classes; unavailable or missing: Forecast `attribution.reason` or fail-closed unavailable, never invented drivers); no ranking or page-side pressure or attribution math; when pressure is not ready it prints Forecast's reason, not a blank success. From that same call it reprints `debtDirection` when `debtDirection.status === 'ready'` — household and per-debt opening/ending/delta/direction, declining/persistent/increasing id lists, `anySupportedIncrease`, `inventedBorrowing`, and `availableCreditIsNotCash` when Forecast publishes them, per-debt interest when calculated or unavailable reason when not, and `cleared-within-published-horizon` milestones when Forecast published them; Forecast order preserved, plain language, no ranking or payoff-order recommendation and persistent is not presented as a comfort band; when debt direction is not ready it prints Forecast's reason, not a blank success. Not a goals engine, not a second sequence, not a second total, not a second cash or debt walk |
| Plan spend page — known future costs list | `Forecast.planSpendPaydayFunding`, published on `Forecast.recommend.planSpendPaydayFunding`, is the sole serial funding-allocation authority for active dated protected planned costs. It reads the incumbent master `simulate` daily balances and exact payment events, `fundingSequence` floors/order/dates, and `majorPlans` verdicts. Each Seaspan period's maximum new earmark is its master-walk cash change with its already-counted planned point payments added back; the first period includes unprotected opening cash above the model buffer. A daily cash-headroom bound limits carried protection. A backward cumulative-demand pass then publishes the latest-feasible, minimum-now contribution: lowering a positive contribution by one cent misses a protected deadline even if later periods contribute their full capacity. Earmarks never enter `simulate` as expenses. Their projection opens at zero without purpose configuration; eligible explicit purpose reserves separately publish actual backed seeds, capped at the matched requirement, and allocate only the remainder; point payments consume named protection once when the incumbent cash event occurs, while a dated range floor stays reserved without a fabricated payment. Undated and optional rows receive no protected payday allocation. An earliest payday funding gap is explicit. Road Ahead Stage 1/2 standalone period results are not added into a reserve. `Forecast.planSpendCards` keeps Fusion as one display group while its instalments remain distinct cash events. `public/plan-spend.js` reprints the Forecast schedule and `majorPlans` verdicts, including `AT RISK` only for protected uncertainty. A Forecast cash date is a planning date, not necessarily a merchant due date. If current operating state is unavailable, action figures are withheld. The page performs no financial arithmetic. |
| Budget original-plan / actual progress and period goal evidence | `Forecast.budgetPeriodProgress`, published by `Forecast.recommend.payPeriodViews[].budgetProgress`. Read-only composition of incumbent calendar planned/observed amounts and actuals coverage. Original scheduled/category plans stay distinct from actual movement and reserve holds. Partial observations are explicit, future actuals unavailable, missing/null trust unpromoted. Exact future/payday requirements reprint the incumbent allocator minimum-now fields only with complete attribution; they are current Forecast requirements, not original payday snapshots. Goal fulfillment stays Not confirmed: no original period plan or attributable contribution ledger is inferred from balances, assignment revisions, proposals or cost settlement. No cash-walk, deduction, funding, observer, settlement, classification, allocation or baseline change. `public/plan.js` renders pairs, dimensionless geometry and native evidence. |
| Budget selected-period proposed savings | `Forecast.recommend.payPeriodViews[].plannedCostFunding`, composed inside Forecast by `publishBudgetPeriodFunding` through the incumbent `simulate` / `fundingSequence` / `planSpendPaydayFunding`. The cash walk uses the same published period income, assigned bill load and exact household holds as the selected Budget waterfall, including cadence and estimated payroll, rather than the searched weekly cap. It fails closed if that walk does not reconcile. Opening operating cash may protect the path but is not new period income or contribution capacity. The incumbent serial allocator keeps latest-feasible order, daily headroom, point-payment consumption, undated protection and explicit gaps. Yearly card-paid bills explicitly assigned by purpose-reserve yearly-bill goalRefs (including Square One) are excluded from paycheck Bills by calendarBillSections; their native expense, funding requirement and reserve draw remain once. Annual card fees without that Savings assignment retain their owner-directed Bills deduction. Their unfunded native amount stays protected in the internal operating carry, future extra-debt projection and major-purchase capacity; unknown annual amount or timing withholds those allocations. A represented Savings expense after an original payday snapshot withholds that snapshot-derived carry; the existing native observed-opening walk may supply the future opening without replaying the expense or reconstructing historical backing from current stock. A bill payment already deducted in Bills adds back only projected consumption of named earlier earmarks, once, as a separate planning credit. Forecast publishes contribution, cumulative proposed funding, remaining gap, trust and the final proposed remainder; the page only reprints them inline and suppresses the old cap-basis banner for these rows. Missing current-period spending/schedule, original payday snapshots, actual saved balances, destinations and source attribution remain unavailable. No two-pot allocation, silver ordering, baseline store, target change or transfer is authorized by this publication. Purpose-backed assignments are published separately from cumulative proposals. The matched reserve portion and earlier proposed bill protection offset an already-deducted bill once; neither is new contribution capacity. |
| Bills page — recurring household bills | `Forecast.householdBills`, from `plan.bills` through the incumbent `occurrences`, `knowledgeHorizon`, `billIsHouseholdObligation`, `billIsSubscription`, and `monthlyCadenceSibling` rules. Presentation only in `public/bills.js`, using the shared Credit fact-card language. Subscriptions and memberships stay off this page via `Forecast.billIsSubscription`: explicit plan `subscription: true` / `false` is the product class; when that flag is absent, `budgetCategory: subscriptions` remains the default. Spending `budgetCategory` alone does not decide the Bills roster — a membership can stay Sport for Lunch Money actuals and still be a subscription. Occurrence stubs of a recurring series (once-rows whose id prefixes a recurring sibling) are omitted so the series appears once. Cadence is the plan frequency; a monthly-equivalent is derived only for monthly / biweekly / quarterly / yearly using the same 26/12, /3, /12 identities `budgetBreakdown` uses for dated-item netting — once and unknown cadence contribute no monthly figure and are not smeared across a window. Next date is the first `occurrences` date on or after as-of, or the scheduled once date even when that date is before as-of; a passed date is not settlement. The page total is the sum of known monthly-equivalents, labelled as a comparison figure, not as the amount that leaves every month. An absent fact stays `null`; the page prints Unknown, never $0 or a relabelled monthly bill. Not a second planner, settler, subscription view, or bill engine |
| Subscriptions page — recurring subscriptions and memberships | `Forecast.householdSubscriptions`, the complementary projection of the same `plan.bills` authority `Forecast.householdBills` uses. Presentation only in `public/subscriptions.js`, using the shared Credit fact-card language. Roster membership is `Forecast.billIsSubscription` plus `billIsHouseholdObligation` minus occurrence stubs: explicit `subscription: true` / `false` is the product class; when that flag is absent, `budgetCategory: subscriptions` remains the default. Spending category alone does not decide the roster. Cadence, next date, monthly-equivalent, and the page total reuse the same helpers and 26/12, /3, /12 identities as the Bills view. A yearly or biweekly charge keeps that cadence; the monthly-equivalent is a comparison figure, not a claim that the charge leaves monthly. Cancelled or never-promoted services are whatever `plan.bills` already excludes; this projection does not resurrect historical merchants. An absent fact stays `null`; the page prints Unknown. Not a second planner, subscription store, cancellation tracker, or recurring-payment engine |
| Bill occurrence price selection — bounded promotional terms (`bill.amountSchedule`) | `Forecast.billOccurrenceAmount` selects each bill occurrence's amount by that occurrence's actual date: a bounded promotional term applies only to occurrences dated inside it, and the regular price is restored automatically outside every term. A malformed schedule or an unknown term amount fails closed for only the affected occurrences and their dependent outputs (never an invented or averaged figure), and confidence is never promoted by a term. Unscheduled bills are unchanged. |
| Revolving headroom, limits, pending | `Forecast.utilisation`, from posted `debts` plus pending via `openingBalance`. Chequing B overdraft `used` is `max(0, −` the `chequing-b` cash-register balance `)`; the facility keeps its own limit, label and note. Synthetic fixtures may still pass `used` with no `cash` id |
| Household-facing available in chequing | `Forecast.chequingAvailability`. Positive current Chequing A and Chequing B balances plus unused Chequing B overdraft (`max(0, limit − used − pending)`, with used `max(0, −chequing-b)`). Current observed cash comes from live-plan `liveOverlay.observedCash` when that packet is complete and freshness-qualified; otherwise the Forecast opening cash rows. Savings is excluded. Credit-card and HELOC capacity never enter. Overdraft is borrowed capacity, not cash and not the Forecast spendable opening (`startingCashAmount`, chequing-only). Designated savings stays on the breakdown as reserve evidence. **Not the Plan page cash figure.** Forecast publishes Current Balance as canonical `chequing-a` / BILLS ACCOUNT (`paydayAllocation.liveCurrentBalance`). Normally that is posted hub cash, fail-closed when the row is missing or untrusted. On a scheduled Dale/Seaspan payday, until that payroll is represented, it is a proven immediately pre-payday BILLS balance plus that planned payroll. A same-day refreshed BILLS balance is not that base; if the pre-payday balance cannot be proved, Current Balance fails closed rather than adding the planned payroll again. The Budget page prints that same Forecast Current Balance; it does not compose a second household cash figure, and it does not add Weekly or Savings. Unused overdraft capacity never enters. Dated from provider cash-observation evidence and printed outside the payday snapshot. Payday balance is the pay-period income identity (`calendarPeriods[].available` = `incomeTotal`), not the frozen opening plus assigned period income. The household remaining on that sheet is Balance After Deductions (`incomeTotal − periodBillLoad − Household Budget hold`). Savings and TENNIS INCOME never enter Current Balance. Not payday allocation, weekly cap, or LEFT OVER. `public/chequing-headline.js` holds the wording for the capacity report only |
| Budget — owner targets against actuals, including the grocery and fuel monthly figures the Plan page prints | `Forecast.budgetBreakdown`, with classification, owner targets, and any current-regime assumption in `data.json` `plan.budget`. Each category's `gross` is the pre-dated monthly amount (owner target if present, else current-regime undated + dated, else historical); `planned` is that amount after dated items and after any undated current-regime amount `Forecast.simulate` already reserves as daily cash. A `currentMonthly` value is the known undated current recurring amount and outranks the historical average; it loses to an owner target. It is not a due date and not a second bill engine: the cash walk reserves it daily so a card-paid service without a trustworthy day has gravity without a fabricated day. A dated card-paid bill is also current-regime: it occupies dated, reserves on the planning day, outranks historical, and is not a second chequing withdrawal. The weekly-cap remainder does not carry reserved current-regime cash again. Essential/required monthly totals still include that reserved amount, so coverage does not rise while the walk still deducts it. The `cap` block compares the weekly figure on screen with the in-cap planned essential/unknown remainder only — reserved current-regime is not a second load on that cap — and publishes the grocery/fuel pair from those fields without re-deciding the fallback. `public/plan.js` holds the wording only |
| Weeks in a month, and every figure converted between the two | `WEEKS_PER_MONTH` in `public/forecast.js` — the calendar's own `365.25 / 12 / 7`, deliberately **not** exported. `Forecast.monthlyFromWeekly` says a weekly cap in months; `Forecast.budgetBreakdown`'s `cap` block owns every other conversion |
| Whether the weekly cap leaves any discretionary room, and the shortfall when it does not | `Forecast.budgetBreakdown`'s `cap` block, measured against the weekly figure the page is **showing**; `public/plan.js` holds the wording only |
| The mission — which instructions the homepage gives, and in what order | `Forecast.mission`, from the `recommend` and `projectDebts` results. When `recommend.mode` is `infeasible`, that is the mission outcome and spending / surplus-use instructions are not emitted. When `recommend.nearBoundary` has items, that instruction is emitted before surplus-use (`helocLimit` / `surplusToCard`); `public/plan.js` holds the wording only |
| The status band — which of eight verdicts the Plan page publishes about the window, and the dates inside it | `Forecast.planStatus`, from the `recommend` result and the simulation on screen; `public/plan.js` holds the wording, the tone class and the HTML only. `infeasible` is copied from `recommend.mode` / `advice.infeasible` |
| Current funding-option available / revolving headroom used to cover an opening gap | `Forecast.resolveFundingSources`, from extra-facility `cash` locators, `Forecast.utilisation` (`debtId` locators and residual unclaimed revolving rows), and extra facilities. A `cash` locator onto `plan.startingCash.heldElsewhere` is observational identity only: the raw TENNIS INCOME balance is not household funding. Capacity on that option is an explicit owner-authorized `available`, else 0 while Q25 is OPEN. Stored `plan.funding.options[].available` is not current-state for utilisation or extra-facility locators. A usable option with a declared planning available and no locator keeps that figure. `Forecast.recommend` consumes that view for display and for cash opening-gap recovery. A `debtId` option's headroom remains visible capacity and is not automatic opening-gap cash; a legacy `fundingDebtId` without declared sources cannot authorize an opening-gap draw by itself. Planned borrowing stays `Forecast.plannedDebt`. `public/plan.js` holds the wording only |
| Whether a funding source covers the opening gap, contributes to it, or cannot reach it | `Forecast.recommend`'s funding result — `funding.sources`, the same allocation seen per source; `public/plan.js` holds the wording only |
| Alternative opening-gap assumptions — which counterfactual applies, what assumption stands for it, and whether its answer means anything | `Forecast.counterfactuals`, from the `recommend` and `projectDebts` results. Each alternative copies `recommend`'s `planOptions` and replaces exactly one key, so the scenario, buffer, overrides, disabled commitments and debt state cannot drift from the plan on screen. Full coverage is exactly the shortfall, finite and non-borrowed; a facility funds the gap only through its own declared headroom. `public/plan.js` holds the wording only |
| The May 2027 renewal — what it costs, what folding the HELOC in changes | `Forecast.renewal`, from the debt records and `plan.obligations`; `public/modellers.js` holds the wording only |
| Mortgage rate conventions — what a quoted rate means | `RATE_BASIS` in `public/forecast.js`: fixed compounds semi-annually, variable monthly. `Forecast.renewal` requires the basis and has no default |
| The next move the household is told to make | `plan.actions` in `data.json` for owner-policy rows (what, amount, due, owner). Current-limit satisfaction on a row with `debtId` is `Forecast.resolveActions` from utilisation (unknown pending or over-limit stays `open`; otherwise `done`). `public/plan.js` renders `Forecast.resolveActions` / `Forecast.nextMove` |
| What the next move achieves — which of five outcomes the "What happens after" line publishes, and the figures inside it | `Forecast.nextMove`, from the `recommend` result, the simulation on screen and `plan.actions[0]`. The action's amount is a fixed figure sized for the default buffer, so coverage is judged against the **current** gap on the engine's own half-cent — and restoring that gap takes coverage **and** a due date on or before it, since money arriving after the day it is needed clears nothing on that day. `public/plan.js` holds the wording only |
| Where the next surplus dollar goes | `plan.nextDollar` in `data.json` records the owner-stated policy only. `Forecast.debtPriority` applies it to current eligible revolving-card and HELOC facts, fails closed on equal or unavailable rates and on null/missing/non-finite balances, and returns the current target, ordered cascade, and conditional next target. Unknown pending is not $0: leftover after proven posted exposure is held, not sent to a later target or optional residual. `Forecast.paydayAllocation` owns the amount; `Forecast.projectDebts` consumes the same order. Pages rank nothing |
| Household decision posture — aggressive but not brittle | `plan.decisionPosture` in `data.json` records the owner-stated policy only. Forecast does not apply this row in this slice. The read-only assistant packet projects the closed labels onto `policy.decisionPosture`; Talk may explain those labels. This row stores no numeric breathing-room threshold, safe-to-spend, allocation, payment, or borrowing permission. It does not redefine `defaults.targetBuffer`. |
| Dale/Seaspan payroll planning assumptions — future raise factor, bonus rate, and authorized-through year | `plan.payrollPlanningAssumptions` in `data.json` records the owner-stated planning assumptions only (+4% raise, 18% bonus of evidence-supported eligible salary, authorized through 2027). `Forecast.daleEstimatedPayrollDeposits` is the only statutory calculator. `Forecast.projectedDalePayroll` is the one projected source both `Forecast.baselineTrajectory` and Budget timeline rows consume, including the current row until observed or represented evidence supersedes that occurrence, and it fails closed if the assumptions are absent. Future, next, and current rows use that source for Dale dates from 2027-01-01 and mark it estimated until that evidence; past rows do not. When the assumptions are absent, current and next keep the incumbent amount and further 2027 cycles are omitted. They stay ESTIMATED and never promote to verified. Evidence-derived salary, raise anniversary, bonus cadence, and statutory tables stay in Forecast. A later year is unpublished until a later regime is authorized and independently proved. |
| Hypothetical extra payment against one eligible debt | `Forecast.hypotheticalExtraPayment`, composing `Forecast.simulate` and `Forecast.projectDebts`. Cash baseline and scenario copy incumbent `Forecast.recommend` `simOptions` with `weeklyVariable: advice.weekly`; they do not assume zero weekly spend. The caller supplies a finite numeric (`typeof number` + `Number.isFinite`) positive whole-cent amount, one stable eligible debt id (revolving unsecured or HELOC), the plan-opening as-of, and `nature: hypothetical`. The extra is one dated `kind: extra` event on that as-of, not monthly `extraDebtMonthly` and not `Forecast.counterfactuals`. Owner `plan.nextDollar` is not substituted for the caller target; leftover does not cascade to the priority chain. `defaults.targetBuffer` is not a payment, spendable-cash, or breathing-room answer. Deltas come only from those Forecast walks. Consequences Forecast cannot establish are omitted rather than zeroed. The amount is not spendable cash; available credit is not cash. No recommendation and no action permission. Stateless and read-only. Pages and Gemini do not recalculate. Talk may extract only an explicit caller amount plus named debt; `scripts/talk-hypothetical.js` validates, resolves one stable id, and calls this Forecast boundary. Missing amount or target, and planner-act asks, stay unavailable |
| Baseline cash-and-debt trajectory over the knowledge horizon | `Forecast.baselineTrajectory`, composing incumbent `Forecast.knowledgeHorizon`, one Road Ahead normal-spending input, `Forecast.simulate`, and coupled `Forecast.projectDebts`. That input is the Forecast-owned provisional recent pay-period baseline when `currentPeriodActuals` covers both the previous completed Seaspan cycle (posted eligible normal spend) and the current Seaspan cycle (eligible actual-to-date plus the unspent incumbent payday reserve). The combination is `(completed posted actual + current full-period estimate) / 2`, converted once into `weeklyVariable` for the same walk Month and Pay Period already share. It is an estimate, not an established household average, and it does not replace scheduled income, bills, debt obligations, or dated commitments. Owner Household Budget targets stay on `plan.budget`. When coverage cannot establish both windows, the walk keeps `Forecast.budgetBreakdown` planned weeklyVariable (owner-target / current-regime Household Budget planned remainder — not historical actuals and not `Forecast.recommend`'s feasible weekly cap) and publishes why the recent baseline is unavailable. That fallback is not $0. Budget secondary Month and Pay Period views pass selected spending with its explicit-setting/recommendation identity and the incumbent `Forecast.recommend.holds` verdict. `Forecast.baselineTrajectory` does not accept an unsupported implicit zero cap as a zero-spending instruction: it retains its provisional/planned baseline, or fails closed when that basis is unavailable. Explicit owner zero remains a valid planning setting. The secondary funding-detail walk copies the trajectory-published `weeklyVariable` rate, so a rejected cap cannot re-enter as an implicit zero in `simulate`. Its published amount, trust and source pass through `simulate.weeklyVariableBasis`; `planSpendPaydayFunding` preserves that basis and includes its trust in `fundingTrust`. Unknown trust or a basis that does not match the walked rate fails funding closed. The main operating cap path remains unchanged. The monthly series covers every calendar month that intersects the incumbent knowledge horizon. It does not extend `knowledgeHorizon`, change published caps, or year-stop global `expandEvents` / `simulate` / `recommend`. Named dated income-regime split (trajectory-local, `isDalePayrollStream` and `Forecast.daleEstimatedPayrollDeposits`): current modelled Dale net through 2026-12-31; Dale payroll/bonus from 2027-01-01 through 2027-12-31 is an evidence-derived ESTIMATED regime when Seaspan salary evidence is present (deposit-year CPP/EI reset; planning estimate — not verified future pay), not $0 and not expandEvents-carried 2026 post-CPP/EI-max net. After 2027-12-31 that path fails closed until a later regime is authorized and independently proved — not the 2027 raise, bonus rate, or last-published statutory tables carried forward. Streams without Seaspan evidence stay fail-closed unavailable. Dale/Seaspan-owned bonus uses the same ownership signals as Dale payroll; Amanda/other bonus is not treated as Dale. Owner-authorized planning assumptions (future raise factor, bonus rate, authorized-through year) live in `plan.payrollPlanningAssumptions`; `Forecast.daleEstimatedPayrollDeposits` / `Forecast.baselineTrajectory` read them and fail closed if they are absent. They stay ESTIMATED and never promote to verified. Evidence-derived salary, raise anniversary, bonus cadence, and statutory tables stay in Forecast. `incomeRegimesImplemented` is true only when that Seaspan-evidenced 2027 Dale net exists. Only an income occurrence actually settled into the relevant opening may replace its estimate; a future represented date cannot suppress an unsettled estimate. Cash after 2027-01-01 is estimated on that walk through 2027-12-31, or unavailable while withheld Dale income would otherwise enter it. `pressure` / `pressure.signals` are walk-derived mechanical facts from that same daily cash series, `expandEvents`, published month-end cash, coupled month-end debt marks, and incumbent `projectDebts.crossings`: lowest published projected cash, per-month daily-close troughs, positive-to-negative cash including a walk that passes through zero, adjacent-month cash declines, months whose dated plus reserved/variable outflows exceed inflows, dated commitments on published-cash days (trust is the weaker of the commitment input and the cash walk; an estimated input is never published as calculated), adjacent-month debt increases, debt that does not decline after a coupled paid increase, and facility limit crossings (withheld when revolving pending exposure is unknown and the posted opening is not already over the limit). Unpublished cash or debt months contribute no invented signals. No household minimum, breathing-room, safe-to-spend, RYG, risk-score, or affordability threshold. Ranking / recommendation stay null. Read-only. `public/planning.js` reprints the monthly series (status, amounts, notes) and does not recalculate. Each pressure signal also publishes walk-derived cause attribution that reconciles to that signal's trajectory change from the same events, Household Budget daily drain, and coupled debt marks — or fails closed when candidate drivers cannot be established. Candidate driver classes, only where the walk can prove them: income-timing (including two-pay vs three-pay cadence as a fact), planned Household Budget spending, recurring bills, debt payments, debt interest, dated commitments, bonus timing, payroll-deduction-regime facts from estimated deposit records with the same gross and different deductions, and mortgage obligations already in Forecast. Attribution invents no residual 'other' class, comfort threshold, ranking, recommendation, or affordability. `debtDirection` is a tightly composed read-only horizon picture from that same coupled `projectDebts` walk: as-of `openingBalance` versus the last published month-end mark. It answers which modelled debts decline, which remain persistent (last published mark equals the as-of opening after whole-cent rounding — not a comfort band), whether any supported balance increases, interest consequence from those marks where Forecast can establish it, and payoff/progress milestones the published marks already support (first published month-end at which a modelled balance is $0 after a positive opening). Unpublished debt months contribute no invented direction. Planned Household Budget weeklyVariable does not manufacture future card borrowing. Available credit / headroom is not cash and is not a direction input. No ranking, recommendation, affordability, or owner-policy threshold. The helper is not a second exported engine. Planning reprint of pressure, debtDirection, Talk templates, and packet reprint of attribution or debtDirection remain out of scope. `scripts/assistant-packet.js` projects the same reprint as `planning.trajectory` on `GET /assistant/current`, MCP `get_atlas_current`, and session `GET /talk/context` (same `Forecast.baselineTrajectory` call; not gated on `liveOverlay.operatingPlan`). That projection labels month `cash` as the cumulative walk close and copies `roadAheadSurplusDeficit` identity without reprinting stage cent amounts. Talk Ask NL trajectory templates remain deferred; Talk does not reprint trajectory in household answers. Not a second planner, not ranking, recommendation, or affordability. Each published calendar month also carries a Forecast-owned three-stage selected-period funding decomposition from that same walk's already-built `expandEvents` plus the planned Household Budget `weeklyVariable` already applied by incumbent `simulate` on the walk days in that published month — not a second calculator, not a separate calendar-day smear, and not a residual balancing bucket. Stage 1 (normal life) is projected income − joint-cash recurring bills − required debt obligations − planned Household Budget (walk-applied `weeklyVariable / 7` for each `simulate` day in the month). Stage 2 (after planned spending) is Stage 1 − dated non-optional commitments applicable to the month − yearly card-paid bills in that same span (the Square One class; already expanded once as `kind:'bill'`, not a second commitment, not Stage 1 joint-cash bills). Stage 3 (after debt strategy) is Stage 2 − planned extras from `plan.defaults.extraDebtMonthly` / walk `kind:'extra'` only, including honest $0 when the default is zero. Each stage publishes reconcilable component totals and a result. Stage 1 income also publishes attributable named lines from that span's income events: Dale (Seaspan payroll via `isDalePayrollStream`) and Amanda (Tennis BC salary via `isAmandaSalaryStream`) when those sources contribute, plus remaining modelled income (including child benefit) so `sum(lines)` equals the unchanged `stage1.income.amount`. Coaching/gravy is not encoded as a Dale or Amanda salary line. Stage 1 `bills` and `obligations` (Required debt payments) also publish attributable named lines grouped by id/label from the same span events already used for those rollups (joint-cash non-card-paid bills; required debt obligations); each event line carries `id` / `label` / `date` / `amount` / `status` (`date` only when the group shares one event date); line amount is the absolute outflow sum and trust is `trajectoryEventsStatus` of that group, so `sum(lines)` equals the unchanged component `amount`. Stage 2 `commitments` publishes that same named-line shape from the same span planned-spending events already used for that rollup (`kind:'commitment'` plus yearly card-paid `kind:'bill'`), via the same `baselineTrajectoryEventLines` helper MonthFunding uses for bills and obligations, on both the month and pay-period paths; `sum(lines)` equals the unchanged `stage2.commitments.amount`. Stage 1 `householdBudget` publishes attributable lines from the same `plan.budget.categories` that feed planned `weeklyVariable` (owner-target / current-regime `budgetBreakdown` planned remainder, not historical actuals and not reserve). Each contributing category shares that walk's pennies by its planned remainder. `every-other-seaspan` keeps that share only on ON-cycle days; the smoothed OFF-cycle share is an explicit `Normal spending estimate` residual and is not renamed onto another category, so `sum(lines)` equals the unchanged walk-applied `householdBudget.amount`. A nonzero total whose named shares are all absent still publishes that residual rather than an empty breakdown. When the provisional recent pay-period baseline is ready and its own category cents already sum to that 14-day amount, the lines are that blend — named categories plus the unassigned Other spending residual — and owner targets are not added again; otherwise one Normal spending estimate line is published. A single Household budget smear line is published only when that walk-applied total is non-zero and no contributing category can be named. Empty sets omit `lines` rather than inventing $0 rows. Planning reprints published `lines` / `items` and does not invent splits. Stage arithmetic is otherwise unchanged. Trust is `calculated` or `estimated` from the same trajectory rules and is never promoted; unavailable income or cash for that month fails the stages closed rather than inventing $0. Ranking / recommendation / affordability / min-cash / breathing-room / safe-to-spend / RYG stay null. Each published stage result uses identity `standalone-period-surplus-deficit` with `priorPeriodSurplus: excluded`. It does not add the prior month's or prior pay period's surplus, and it is not the cumulative walk close. The ready trajectory publishes `roadAheadSurplusDeficit` naming that identity, with `stage3.result` as the household Road Ahead funding result. Published `cash` is `cumulative-walk-close` and `roadAheadFunding: false`, retained for the internal walk, pressure, debt direction, and scenarios. Stage 3 does not read `Forecast.baselineTrajectoryScenario` amounts, payday true-surplus, or `plan.nextDollar`. The same walk also publishes a Seaspan payday-to-payday `payPeriods` series covering every incumbent spending-cycle window that intersects the knowledge horizon, clipped to that horizon the same way months are clipped. Each published pay-period carries the same three-stage funding decomposition (Normal life / After planned spending / After debt strategy / projected result) from the same helpers and trust rules; Household Budget is walk-applied `weeklyVariable / 7` on simulate days in that pay-period, not a 14-day calendar smear. Unavailable is not $0. A missing Seaspan payroll calendar fails the pay-period series closed (empty array; not invented 1st–15th / 16th–month-end halves) and does not withhold months. Month and Pay Period are two views of one walk, not a second calculator. The household-facing Road Ahead Month stages are not that calendar slice: they sum the incumbent standalone pay-period Stage 1 results whose Seaspan cycle close falls in the month, then subtract dated planned spending and the closing periods' extra-debt amounts. Month `income` keeps identity `calendar-dated-income`: the dated income events in that calendar month, with the same named lines, and is not the closing periods' stage1 income. Planning reprints that calendar income separately from close-month funding. Month Stage 2 retains its standalone net arithmetic; a separate Forecast-owned dateOrderResult carries dated shortfalls into the household-facing Month result without applying later pay-period closes backward. Calendar income and close-month funding are not required to equal each other. A dated requirement cannot use surplus whose pay period closes after that date. Horizon-clipped cycles have not closed and contribute no surplus. Pay-period stages, calendar-month cash, debt direction, and pressure stay on the walk. Planning reprints the published month stages and does not add pay periods itself. Month bill and required-payment lines stay one dated occurrence per id and date across the closing pay periods. When the date-order Month result differs from Stage 1 minus planned spending, Forecast publishes `unavailableByDueDate` on that date-order result; Planning reprints it and does not calculate a balancing amount. `additionalCashRequired` republishes that same walk's zero-floor shortfall (`Forecast.simulate.additionalCashRequired` = `max(0, 0 − sim.min.balance)` on the chequing-only opening) as `amount`, and Forecast-owns the designated-savings backing of that same total: `fundedByDesignatedSavings` is `min(amount, max(0, designated-savings-balance))` from the incumbent `savings` / EMERGENCY SAVING breakdown row only (actual opening evidence; planned reserve contributions are not funded; TENNIS INCOME, SAVINGS-DONT TOUCH, Wise, and other non-designated cash are not this reserve), and `remainingAdditionalCashRequired` is `max(0, amount − fundedByDesignatedSavings)` and is never negative. Raising or lowering designated savings changes funded/remaining and does not change chequing-only `amount` (Case K: the ordinary walk still does not spend that reserve). Unavailable walk min or untrusted/missing designated-savings evidence on a household chequing opening fails closed — not $0 and not funded. Period `stage*.result` deficits must never be summed to derive the total. Funding floor is $0, not `targetBuffer`. This packet is FOUNDATION — NOT COMPLETION: Prepare Ahead protection is `Forecast.paydayAllocation.protectedPath` (keep-in-chequing leftover before extra debt), not this remaining-ACR packet. Prepare Ahead UI, Budget reserve-line, payday spreading, automatic transfers, reserve-release, and transfer-to-Savings-to-fund-ACR remain out of scope. Planning / packet / Talk reprint of the pay-period series, packet / Talk reprint of the stages, other O4 scenario classes, and Outcome 5 remain out of scope. Caller-supplied additional-debt-payment scenario consequence against this same planned-HB coupled walk is `Forecast.baselineTrajectoryScenario`, not `Forecast.hypotheticalExtraPayment` and not `Forecast.counterfactuals`. |
| Trajectory additional-debt-payment scenario against the baselineTrajectory walk | `Forecast.baselineTrajectoryScenario`, composing the same planned Household Budget weeklyVariable / `knowledgeHorizon` / Dale estimated payroll `walkOpts` `Forecast.baselineTrajectory` already builds (`prepareBaselineTrajectoryWalk`, not exported), plus incumbent `Forecast.projectDebts` / `Forecast.simulate` hypotheticalExtra-style absorption. The caller supplies `nature: additional-debt-payment`, a finite numeric (`typeof number` + `Number.isFinite`) positive whole-cent amount, and one stable eligible debt id (revolving unsecured or HELOC — same Slice 6 eligibility). Nothing is inferred from cash, buffer, HELOC funding, `plan.nextDollar`, `plan.decisionPosture`, or Gemini. The extra is one dated `kind: extra` event on the as-of, not monthly `extraDebtMonthly` and not `Forecast.counterfactuals`. Owner `plan.nextDollar` is not substituted for the caller target. Forecast publishes that identical baseline (weeklyVariable, horizon, last published cash close where the trajectory walk established it, named-debt from the coupled horizon walk) plus the scenario walk and deltas for cash / named-debt / interest where those walks establish them. Unpublished cash is omitted, not $0. Fail closed when `baselineTrajectory` would be unavailable, the named debt is ineligible, or the input is incomplete. Ranking, recommendation, and affordability stay null; `actionPermission` is not-granted; `writesCanonicalState` is false. Not `Forecast.hypotheticalExtraPayment` (that walk is `recommend` weekly). Not a second exported planner. Stateless and read-only. `public/planning.js` reprints Baseline vs Scenario from explicit household input on Road Ahead only; assistant packet / Talk reprint, Talk templates, Outcome 5, ranking, affordability, min-cash / breathing-room / safe-to-spend / RYG, inferred money moves, commitment edits, and production writes remain out of scope. |
| Hypothetical extra-payment comparison of two or more explicit extras | `Forecast.hypotheticalExtraPaymentComparison`, composing `Forecast.hypotheticalExtraPayment` once per caller-supplied scenario against one identical household baseline. The caller supplies `nature: hypothetical-comparison` and `scenarios[]` of at least two explicit `{ amount, debtId }` rows (optional stable `id` for correlation only). Each amount and debt uses the Slice 6 finite-numeric (`typeof number` + `Number.isFinite`) whole-cent and eligibility rules; nothing is inferred from cash, buffer, HELOC funding, `plan.nextDollar`, or `plan.decisionPosture`. One unavailable scenario fails the whole comparison; unavailable is not zero. Shared baseline cash is the incumbent `recommend` `simOptions` / `weeklyVariable: advice.weekly` walk already established by Slice 6. Ranking, recommendation, and affordability are null; action permission is not granted. Not `Forecast.counterfactuals`. Stateless and read-only. Talk may extract only two or more explicit caller amount plus named-debt pairs; `scripts/talk-hypothetical.js` validates the extract against the original question, pairs each amount to its named target, resolves each label to one stable eligible id, and calls this Forecast boundary. When the caller asks preference over an already-earned explicit two-option A-vs-B, Talk applies the owner A-vs-B preference rule to those Forecast figures only: same household cash-ending consequence, both extras fully absorbed by their named debts, and a strictly greater Forecast-calculated named-debt interest reduction. After exactly one such earned A-vs-B in the current Talk session, a bare “Which one?” refers to those exact two options and invokes only that same owner rule. Session uniqueness is a compact ephemeral comparison-identity signal keyed to the auth session; it survives 8-turn eviction and is not household-financial evidence. Gemini may extract only a last-presented comparison referent and cannot choose the winner. Preference judgment is gated to exactly two scenarios. A 3+ option preference ask is NOT YET / INDETERMINATE and does not emit PREFER; ordinary 3+ compare-only presentation is unchanged. Otherwise Talk presents NOT YET / INDETERMINATE. Gemini does not calculate, rank, recommend, infer affordability, or choose the winner. Missing, ambiguous, swapped, or unauthorized planner-act comparison asks stay unavailable. Pages do not consume this boundary in this slice. |
| Payoff modelling — which debts may be modelled, what a payment does to one, and what clears it | `Forecast.payoffDebts`, `Forecast.payoffModel` and `Forecast.paymentForMonths`, from the debt records and `plan.obligations`; `public/modellers.js` holds the wording only |
| Debt rate conventions — what a debt's quoted rate means per period, and how closely a monthly model reproduces it | `PAYOFF_RATE_BASIS` and `PAYOFF_BASIS_PRECISION` in `public/forecast.js`, from each debt record's `rateConvention`. A prime-linked facility is compounded monthly, so a monthly period is **exact**. A card charges a daily rate over the days in each statement cycle, so a monthly period is a **monthly-equivalent** average: exact over a year, and published with the cycle band for any single period. An undeclared convention throws |
| What one debt costs the household in cash each month | `monthlyCashFor` in `public/forecast.js`, from `plan.obligations`; read by both `Forecast.renewal` and the payoff modeller |
| Historical spending series | generated aggregate-only `public/periods.json`, from `scripts/periods.js`. The default input is complete cleaned posted history from the authorized GET-only Lunch Money seam; the adapter excludes transfers, income, debt payments (including incumbent merchant debt-payment patterns such as `CAN TIRE MC`), PayPal funding already represented by the incumbent PayPal allowance, and explicitly `household-external` accounts. Existing derived card evidence fills only the dates before each mapped card's Lunch Money history begins. Mapped HELOC interest is required: when the provider ledger for that account is empty, known local HELOC interest evidence is preserved for uncovered months, otherwise generation fails closed rather than publishing an incomplete series as complete. Per-account coverage (role, canonical id, posted count, date range — never provider ids) is published with the aggregate. Lunch Money `Pets` / `Pet supplies` is not mapped into Atlas Pets; GET-only validation showed that provider category is materially misclassified, so those rows stay `Uncategorised` or are excluded as debt payments until the owner recategorizes them in Lunch Money. Provider identities, payees, and transactions are never published. `--source local` is the explicit file-evidence fallback. Category rollup is `Forecast.rollupSpending`: mixed comparable source types (`essential` and `discretionary`) publish `type: unknown` with the source `types` retained, rather than the first event's class. Totals stay conserved; unknown cleaned labels remain `Uncategorised` and publish an incomplete category claim. The shared `#asof` chip reprints this series' `asOf` as historical spending through, distinct from live overlay spending evidence through `currentPeriodActuals.coverageThrough` / `observationAsOf` (never `fetchedAt`, and never overlay `observedAsOf` as a stand-in for spending coverage); the history as-of is not current-period Spent freshness. |
| Account-balance history — dated openings only | `snapshots/<YYYY-MM-DD>.json`, written by `scripts/snapshot-balances.js` after a successful canonical refresh. Same-date subset of `plan.startingCash` / `debts` (identity, side, currency, posted balance, pending). Mixed-date `positions.csv` rows are omitted. Re-running the same reading is a no-op; a conflicting same-date file fails closed. Not current-state, not Forecast input, not spending history. Spendable completeness for a dated opening is derived from that opening's `plan.startingCash.breakdown` and stored on the snapshot as coverage metadata; `public/plan.js` / `public/balance-history.js` consume that metadata and hold display deltas and wording only. A spendable-household-cash total is withheld unless every expected spendable identity from that dated opening is present. Revolving display shows posted and pending separately and does not trend when pending is unknown |
| Published facts and owner policy | `data.json` |
| Derived publication aggregates of those facts | `Forecast.publicationTotals` |
| Calendar — the on-page month grid and agenda | `renderCalendar()` in `public/plan.js` — **presentation of `sim.events` only** |
| Calendar — the exported `.ics` | `scripts/calendar-ics.js`: cash-payment VEVENTs **derived** from `Forecast.expandEvents` over a longer horizon, including dated card-paid reserves (labelled as reserves that reduce projected joint cash, not as external reminders); standing reminder VEVENTs (statement closes, tax deadlines, mortgage renewal) remain a thin non-cash overlay; mortgage-renewal reminder descriptions, and the 150/120-day look-point labels and dates, derive from `EXT-TD-RENEWAL-001` and do not independently author that claim. `X-WR-TIMEZONE` is `Forecast.HOUSEHOLD_TIMEZONE` |
| Read-only provider observation | `scripts/provider-observe.js` turns a Lunch Money fixture, or a local GET when `LUNCHMONEY_ACCESS_TOKEN` is set, into B91 observations. Live mapping is by provider account ID, not display name. Real live IDs stay in gitignored `docs/connectivity/provider-account-map.local.json` or, in production, in the owner-supplied `ATLAS_PROVIDER_ACCOUNT_MAP_JSON` secret; the committed live map remains the empty schema. Fixture mapping lives only under `docs/connectivity/fixtures/`. Unknown IDs stay unmapped. Mapped revolving-credit pending transactions become `fact: pending` observations (Lunch Money v2: positive debit, negative credit). Same `providerTransactionId` pending+posted collapses to posted and does not double-count. A directed Plaid pending→posted pair — posted `plaid_metadata.pending_transaction_id` equals the pending row's `plaid_metadata.transaction_id` — is the same economic transaction even when Lunch Money `id` values differ; the pending authorization is replaced and is not a second spend or pending exposure. Amount may change. Ambiguous or missing Plaid linkage is not collapsed. Merchant/date/amount similarity is not identity. A unique incumbent bill or obligation identity hit on a pending row is carried onto the posted survivor when provider collapse drops that pending row. The pending hit is the identity basis only: `postingDate` is the posted survivor's known posting date, and `postingDateRelation` is `inherited-pending-authorization` when that date is not the scheduled date — it must not publish `same-day` for a later posted row. A still-pending unique household-cash bill or obligation hit with no amount gate may be named on representedActuals without becoming a representedEventCandidate; unlinked lookalikes do not inherit. Plaid ids stay internal and are not published. Numeric pending is the sum of unresolved mapped pending components. Proven zero pending is emitted only when `GET /v2/transactions?is_pending=true` with no `start_date`/`end_date` completes with `has_more=false`; absence of pending rows inside the bounded `include_pending` history window is not zero and remains UNKNOWN / unproven. Live `/v2/transactions` requests that participate in pending→posted reconciliation set `include_metadata=true`. A pending bill/payment older than 90 days may be presumed settled for current forecasting only (`confidence: inferred`); historical provider status stays pending. That 90-day rule is not a universal STALE threshold. Transaction history is `--history-days` / `--mode current-state` (14 days) or `--mode reconcile` (120 days). A live current-state fetch keeps that ordinary 14-day posted window when Forecast is not still carrying an unresolved once joint-cash occurrence whose permitted posting date is older than the window. If one or more such occurrences remain, the same GET `/transactions` start extends back to the oldest still-carried occurrence plus its permitted posting-date relation, capped at the 120-day reconcile horizon. Wider historical evidence is settlement-only for currently carried occurrences and does not authorize generic historical opening backfill. Pending coverage is unchanged. The bounded `/transactions` window is paginated until `has_more=false`; a truncated posted page is not complete coverage. `representedEventCandidates` require an explicit payee alias + mapped account + direction + an allowed scheduled/posting-date relation. Same-day is the default; a named identity rule may opt into only a weekend occurrence posting on the next business day, or a payment onto a mapped card covering the latest due on or before posting. Named Triangle and MBNA card-minimum rules may instead use `covers-statement-cycle-or-latest-due`: after identity, a payment on or after that card's `debts.statementCloseDay` may settle the upcoming minimum that statement created, and a later payment may still cover the latest due on or before posting. Statement close days are not copied into the observer. Amount is coverage after identity, not identity. A refund or merchant credit is not a card-minimum payment. Amount similarity is not identity and does not write `plan.opening`. After identity is unique, a card extra payment settles that min only when the observed credit is at least the scheduled due. Contradictory, duplicate, wrong-account, wrong-direction, wrong-payee, and out-of-rule-date evidence does not settle. Pending evidence does not become a representedEventCandidate. After identity is established the observed debit may travel as a sanitized `representedActuals` amount, with `postedOn` when the posting date is known. Candidates whose scheduled date is not the current opening as-of are historical evidence and are not fed to the current-opening posting compare; the live overlay may consume one only when its exact id+date is a once joint-cash outflow Forecast is still carrying. Other historical evidence must not backfill `representedEvents`. Same-day CHANGE records no canonical winner when time evidence is missing. `--identity-proof` prints a sanitized identity fingerprint. `--receipt` prints a sanitized observation-coverage receipt: as-of, provider `lunchmoney`, account/posted/pending coverage, identity counts versus the account map, intra-payload pending-to-posted transitions, and whether the packet is complete enough to pass into incumbent reconciliation. Truncated, unproven, or mapped-but-valueless required-cash coverage cannot report ready. The receipt does not classify MATCH/CHANGE, does not write, and does not calculate Forecast. Prior-observation new/changed/unchanged deltas are not claimed; there is no authorized previous-observation store. `--reconciliation-receipt` prints a sanitized current-period obligation-reconciliation receipt gated on that observation receipt. If the packet is not `readyForReconciliation`, classification is not run and the result is not trusted — that is distinct from a trusted run that still has unverified or unmatched rows. When the packet is ready, the incumbent `representedEventCandidates` matcher and `Forecast.currentPeriodObligationStates` classify modeled current payday-period joint-cash occurrences as represented, upcoming, unverified, ambiguous, or outside-coverage. Settlement-state origin is `Forecast.paydayPeriodOrigin` (this payday, else the previous payday), not the truncated observation-date origin `periodOriginDate` uses on an unchanged canonical plan; `currentPeriodAction` is unchanged. A uniquely matched current-period occurrence is listed before its transaction can be marked consumed, so identity-complete evidence cannot disappear from both occurrence rows and unmatched evidence. One transaction cannot settle two occurrences; not-observed is not unpaid. Unmatched trusted household-cash movement is listed as unresolved evidence, not invented into an obligation. The obligation receipt does not write canonical state, does not call `Forecast.recommend` or `Forecast.paydayAllocation`, and is not a second matcher. Instants become household financial dates through `Forecast.financialDate` in the ACCOUNT_FACTS timezone `America/Vancouver`; a UTC `YYYY-MM-DD` prefix is not a household date. Never writes `data.json`. Not a financial authority, not Forecast, and not a silent writer. |
| Trusted canonical refresh | `scripts/canonical-refresh.js` is the earned write path. It consumes the incumbent observer, the incumbent reconciler, and the trusted AF-REFRESH-03 obligation-reconciliation receipt, emits one deterministic sanitized preview, and writes `data.json` only after an exact owner approval matches that preview. The preview keeps mechanically provable posted updates, no-op/replayed evidence, owner-fact questions, ambiguous/unresolved evidence that must not write, and unsupported targets distinct, and names downstream generated artifacts that would change if that exact preview were approved. It does not invent a second writer, matcher, or planner, and the preview does not publish the operating answer. An approved write result projects the household operating answer from `Forecast.recommend` on the written document through `scripts/operating-answer.js`; that projector copies Forecast fields and does not recalculate them. Canonical mode never feeds live-overlay actuals into Forecast. When the obligation-reconciliation receipt is not trusted, those obligation buckets fail closed and cannot invent writes; the earned posted CHANGE allowlist remains the only mechanically provable write set. Four distinct approval contracts: `previewId` (`atlas-canonical-refresh-preview/v1`) authorizes posted household-cash values and posted debt balances whose reconcile status is CHANGE and whose date relation is canonical-older; `cutoverApprovalId` (`atlas-cutover-pending-approval/v1`) authorizes only the exact candidate-date pending transitions and does not advance the opening; `openingApprovalId` (`atlas-opening-cutover-approval/v1`) authorizes one atomic opening cutover binding the complete candidate posted state, the complete candidate pending state, candidate-date `representedEvents`, the incumbent balance-map routing from canonical locator to Household `accountLabel` and `observationId` plus excluded labels, and advancing `meta.asOf` / `plan.opening.asOf` together; `recoveryApprovalId` (`atlas-opening-artifact-recovery-approval/v1`) authorizes reconstruction of missing same-date Household `positions.csv` rows and `snapshots/<date>.json` from a complete MATCH observation packet when that canonical opening already exists, and binds the exact proposed recovered positions and snapshot bytes plus expected artifact pre-state so an unrelated incumbent structural edit cannot reuse the old approval. Recovery never writes `data.json`, never infers those artifacts from `data.json` alone, never advances the opening, and cannot be authorized by `previewId`, `cutoverApprovalId`, or `openingApprovalId`. A fifth approval, `paydayObservationApprovalId` (`atlas-payday-account-observation-approval/v1`), authorizes only `plan.opening.paydayAccountObservations` for canonical `chequing-a` when `Forecast.paydayBoundaryAccountObservation` returns a fail-closed `posted-balance-observed-on-household-date` packet on a Seaspan payday. `--preserve-payday-observation --apply --approve-payday-observation <paydayObservationApprovalId>` is the only write that stores that packet. It does not advance `meta.asOf` / `plan.opening.asOf`, does not rewrite `startingCash`, leftover, Current Balance, or Prepare Ahead, does not write positions or snapshots, and is not a T4 opening cutover. A recorded packet for a different payday is protected and is not overwritten. Combining `--preserve-payday-observation` with `--cutover-as-of` is refused. `previewId`, `cutoverApprovalId`, `openingApprovalId`, and `recoveryApprovalId` cannot authorize it. Unmapped, unknown, stale, same-day, conflicting, credit-capacity, historical-opening, unresolved, and owner-fact evidence are refused and cannot leak into the approved write. Default is non-writing. Optional `--cutover-as-of YYYY-MM-DD` appends the opening-cutover preflight: MATCH is not freshness, unresolved same-day/pending evidence fails closed, UNKNOWN pending and unproven zero block the opening, and same-day scheduled events require representation evidence. Opening-cutover freshness compares those household dates, not UTC date prefixes. Statement cadence may accept older posted evidence without rewriting `evidenceDate`. The preflight preview never writes. `--cutover-as-of --apply --approve-opening <openingApprovalId>` is the only write that establishes a new canonical opening. `--cutover-as-of --recover-opening-artifacts --apply --approve-recovery <recoveryApprovalId>` is the only write that reconstructs missing same-date positions and snapshot for an already-approved opening; it reuses `opening-household-rows.js` and incumbent snapshot-balances semantics and is atomic/fail-closed. Unattended production writes are not this command. A production token is GET-only for the live overlay. It is not a canonical write path. The 2026-09-04 one-transaction `category_id` grant and the later same-day reusable Other Spending `category_id` class are recorded on the production pass and are not this writer. Snapshot history stays `scripts/snapshot-balances.js` after a successful opening. Forecast remains the planner. The live household opening remains a later explicit owner-approved run. |
| Observation-to-canonical cash/debt compare | `scripts/reconcile.js` (non-writing). Maps `docs/positions.csv` Household rows through `docs/reconciliation/balance-map.json` id locators onto `plan.startingCash` / `debts`. Commitment settlement observations live in `docs/reconciliation/commitment-settlements.json` and compare a paid date against `plan.commitments[].settledOn`; they do not go through `positions.csv` or the balance map. Hydro observations live in `docs/reconciliation/utility-observations.json`. Amanda-income observations live in `docs/reconciliation/amanda-income-observations.json`. Card-state observations live in `docs/reconciliation/card-state-observations.json` and distinguish posted balance, pending, limit, available credit, and confirmed payment; they are not a second financial authority. Limit and available credit are never household cash. Unknown pending is not $0. Pending is not manufactured as limit − posted − available unless that identity is proven for that card and timestamp. Posting observations live in `docs/reconciliation/posting-observations.json` and compare whether a scheduled occurrence has posted against `plan.opening.representedEvents`. Forecast remains authority for what should happen; posting evidence is authority for what has happened. Unknown posting is not posted and is not unposted. Does not write `data.json`. STALE is not assigned. The owner 90-day rule lives on pending bill/payment observations in `scripts/provider-observe.js` and is not a reconcile STALE status. Not a universal fact database |
| Current live account state for today's Forecast | `scripts/live-plan.js` overlays eligible posted household-cash and debt balances, plus revolving pending, from the incumbent observer and reconciler onto an in-memory clone of `data.json`. The clone's `meta.asOf` / `plan.opening.asOf` become the observation's household financial date only when the live packet is freshness-qualified for that date. Required spendable cash identities (`chequing-a`, `chequing-b`, `savings`) need acceptable evidence for the effective date, and required revolving pending must be known/current under its applicable cadence. MATCH is not freshness; `fetchedAt` alone does not advance the in-memory opening. If completeness or freshness is insufficient, the overlay fails closed and keeps the dated opening so elapsed scheduled events are not skipped. When that fail-closed overlay has a later observed household date than the dated opening, `liveOverlay.operatingPlan` is unavailable: Forecast withholds current spend permission, current-period action, extra-debt instruction, the current spending-cycle label, and the active calendar leftover chain (later-dated income as arriving, Available as dated cash plus that income, Household Budget / bills / extra-debt leftover as today's waterfall) rather than publishing the dated opening as today's operating plan. The Plan page (payday answer, current hero tiles including Consumer debt, Amanda salary deadline, operating surface, Current Balance glance, and calendar waterfall), `scripts/operating-answer.js`, and `scripts/assistant-packet.js` / `get_atlas_current` fail closed on those current/actionable claims. An unapplied overlay `fetchedAt` / `observedAt` does not stamp dated-opening cash as “Updated” at observation time. Do not pair a later payday cycle with the unadvanced opening. Freshness-qualified posted cash observations are still attached as sanitized `liveOverlay.observedCash` so `Forecast.chequingAvailability` can report current chequing without advancing as-of or rewriting `plan.startingCash`. Stale or incomplete cash observations are not attached as complete. Same-day scheduled inbound cash is not added on top of a complete trusted current-cash observation when posting is unproven or ambiguous: the overlay keeps that opening and Forecast omits the inbound via in-memory `plan.opening.notReliedUponEvents` without putting it on `representedEvents`. A later same-date refresh rebuilds those same-day inbound guards independently of a prior hold and retains the hold until applicable posting proof resolves it. Incomplete or untrusted current cash still fails closed. Same-day unposted joint-cash bills stay still due and do not fail the overlay. Scheduled joint-cash occurrences in `(historicalOpeningAsOf, liveAsOf]` are accounted for before that advance: represented names go on the in-memory opening, and unrepresented joint-cash outflows stay reserved through `plan.opening.priorAsOf` so Forecast does not drop them. A trusted exact transaction-identity candidate may also settle an older once joint-cash outflow that Forecast still carries; this exception does not admit generic historical backfill. A trusted exact candidate may also settle a still-upcoming joint-cash obligation or bill when `Forecast.prepaidJointCashOutflow` names that occurrence; the overlay does not invent a second bill engine. When as-of advances, existing `plan.opening.representedEvents` names that still qualify as in `(historicalOpeningAsOf, liveAsOf]`, `Forecast.carriedOnceJointCashOutflow`, or `Forecast.prepaidJointCashOutflow` for the new live as-of are merged into that in-memory list; identity rediscovery remains additive. Advancing as-of does not discard a still-qualifying Dale-gated prepaid name merely because the live packet did not rediscover it. Any once joint-cash occurrence still carried as unresolved remains eligible for identity-based settlement lookup even when its permitted posting date has aged out of the ordinary current-state transaction window. Named Triangle and MBNA cycle-rule upcoming minima likewise extend that same GET start back to `debts.statementCloseDay` for the applicable statement. Wider historical evidence is settlement-only for currently carried occurrences and does not authorize generic historical opening backfill. Unreceived intervening income is not invented. Historical openings and `snapshots/` stay immutable. When a trusted overlay advances past a Seaspan payday, live-plan retains `plan.opening.paydaySnapshot` from `Forecast.establishPaydaySnapshot` on the pre-overlay dated plan only when that figure is a recorded snapshot or a completeness-proven household-cash walk of the opening-to-payday gap. The walk evidence is the incumbent sanitized `currentPeriodActuals` packet passed as `paydayGapCash`. A current-period `transactionWindow` being paginated-complete is not gap completeness. `scripts/provider-observe.js` earns `currentPeriodActuals.paydayGapComplete` from that observation: the fetch-complete posted window must cover the opening-to-payday household-cash interval, required household-cash identities in the opening breakdown must be mapped, amounts must be trusted, pending coverage must be complete, and no pending-unproven gap cash may remain. live-plan consumes that earned attestation and still withholds unless the window covers the gap and every household-cash movement in that packet can be trusted. It does not reconstruct the opening from today's live cash or from a scheduled-only walk. An already matching snapshot is kept. That retain is in-memory only and is not a canonical write. On a Dale/Seaspan payday, before the same-day chequing-a overlay, live-plan also retains `plan.opening.prePaydayBillsBase` from `Forecast.prePaydayBillsAccountCash` on the pre-overlay plan with the incumbent `currentPeriodActuals` packet (amount, dated opening, through the day before payday, coverage complete). Incomplete gap-day coverage stores nothing. That retain is not today's refreshed BILLS balance, not a new cash store, and not a canonical write. Forecast Current Balance adds posted same-day chequing-a outflows, proven household transfers, and refund-labelled inflows outside 1% of planned payroll, to that base, then the planned Dale payroll. A refund label inside that window fails closed. It must not add planned Dale payroll to the refreshed row. Exactly one inflow within 1% of the planned payroll that is not positively labelled non-income is excluded as the unrecognised deposit. Any other same-day inflow, a retain with no transaction packet, or an incomplete payday movement packet, fails closed. Seaspan merchant text is not an identity. Does not write. Forecast remains the calculation authority; the Plan page renders the clone when `/data.json` overlay is explicitly enabled (`ATLAS_LIVE_OVERLAY=fixture` or `live`). Production `/data.json` uses the incumbent live overlay when `ATLAS_LIVE_OVERLAY=live` and owner-supplied Render secrets are present; otherwise, or if live evidence cannot be trusted, the dated opening is served fail-closed. Production mapping loads the same `atlas-provider-account-map/v1` schema from `ATLAS_PROVIDER_ACCOUNT_MAP_JSON` or the incumbent file path; display names remain labels only. Same-day CHANGE may overlay today's observation and is not a canonical write. Triangle/MBNA statement cadence may keep the canonical posted value rather than overlaying older Lunch Money. Unknown, stale, conflicting, unmapped, credit-capacity, and transfer-as-income evidence fail closed. Available credit is never cash. Owner policy, bills, income rules, and commitments stay on canonical Atlas data. A successful overlay may attach sanitized `currentPeriodActuals` (no raw payee, notes, tags, or provider transaction id; sanitized `displayedPayee` / `originalMerchant` may travel as household-facing merchant identity only on transactions eligible to become Household Budget supporting spending rows) for `Forecast.currentPeriodAction`; that packet is transient overlay evidence, not a stored ledger and not written to canonical `data.json`. Current-period remaining is precise only when every current-period provider account is explicitly dispositioned on the same `atlas-provider-account-map/v1` map; an unmapped actual fails remaining closed. `atlasRole` `household-external` is the explicit non-household disposition on that map. After a trusted overlay, or after fail-closed return to the dated opening, the live-plan result projects the household operating answer from `Forecast.recommend` (`paydayAllocation` / `currentPeriodAction`) through `scripts/operating-answer.js`. The projector does not recalculate those values. Unapplied or incomplete observation cannot raise remaining-claim precision above the Forecast result for that trusted state. Live overlay and canonical apply name distinct provenance modes. Served `/data.json` also attaches a sanitized household refresh-trust packet from `scripts/refresh-trust.js`, copied from the incumbent observation receipt, obligation-reconciliation receipt, canonical-preview classification, overlay metadata, and Forecast remaining-claim / coverage. `public/plan.js` renders that packet on the operating surface and does not invent freshness, settlement, or owner policy. Exact remaining figures stay withheld when that packet says they are unavailable. A canonical proposal is mentioned only when the incumbent preview has mechanically provable rows; there is no approval ceremony when nothing needs approval. `scripts/refresh-loop-acceptance.js` composes those same incumbents into one sanitized on-demand closed-loop packet covering changed live evidence, modeled settlement states, the smallest owner question, the preview-only canonical proposal, Forecast's operating answer, whether that answer changed, and freshness. It never writes. `--live` requires the incumbent owner-verified providerAccountId map (`ATLAS_PROVIDER_ACCOUNT_MAP_JSON` or the gitignored owner-observed local map) and fails closed before any provider GET when that map is missing. Display names remain labels only and cannot reconstruct the map. Replay of identical provider evidence is a deterministic no-op. The 2026-08-25 household-date live closed-loop run is the AF-REFRESH-07 acceptance; campaign-only scaffolding is retired. |
| Payday-boundary posted cash observation — canonical `chequing-a` | `Forecast.paydayBoundaryAccountObservation`. Observed posted balance for one canonical household-cash id whose provider evidence household date equals a Seaspan payday. This slice captures `chequing-a` only. Identity is the canonical id, never a display name. Temporal claim is `posted-balance-observed-on-household-date`: not payday-morning opening, not a pre-transaction opening, not pooled Chequing A+B, not leftover, and not Current Balance. Evidence is a recorded `plan.opening.paydayAccountObservations` row, a same-day freshness-qualified `liveOverlay.observedCash` row, or the non-live-advanced canonical `startingCash.breakdown` row when `plan.opening.asOf` is that payday. Missing, stale, wrong-account, or later live cash fails closed. Unavailable is not $0. `scripts/live-plan.js` may retain that packet in-memory on the overlay clone the same way it retains `paydaySnapshot`; that retain is not a canonical write and is not a previous-observation store. Durable persist of the current payday slot is the earned `scripts/canonical-refresh.js` `--preserve-payday-observation` write: owner-approved `paydayObservationApprovalId` records `plan.opening.paydayAccountObservations` for canonical `chequing-a` without advancing the opening. That persist is not a T4 opening cutover, not leftover, and not a historical previous-observation store. A recorded packet for a different payday is protected. Historical paydays without that evidence stay unavailable. Not a BILLS cash walk, not transaction-completeness, and not a second ledger. `public/plan.js` does not calculate it |
| Posted movements — canonical `chequing-a` | `Forecast.postedAccountMovements`. Proven posted provider transactions that affected one canonical household-cash id during a caller-supplied evidence window. This slice captures `chequing-a` only. Identity is the canonical id, never a display name. Source is incumbent sanitized `currentPeriodActuals` posted transactions: amount, direction, household date, and stable transaction identity. Pending is not posted. A paired internal transfer is one chequing-a movement and is not household income or consumption. `representedActuals` / `representedEvents` / bill schedule occurrences are not extra cash movements. Unknown purpose stays UNKNOWN. Missing, truncated, unmapped, duplicate-identity, or untrusted-amount coverage fails closed rather than claiming completeness. No balancing plug. Not leftover, not Current Balance, not Prepare Ahead, and not the BILLS dollar-for-dollar walk. `public/plan.js` does not calculate it |
| Read-only assistant access to Atlas | `scripts/assistant-packet.js` projects incumbent Forecast, live-overlay, and `public/periods.json` results onto `GET /assistant/current`. That incumbent direct surface is authenticated by dedicated `ATLAS_ASSISTANT_TOKEN` as `Authorization: Bearer`. The household Talk page consumes that same projection through session-only `GET /talk/context` and, when configured, session-scoped explainer turns on session-only `POST /talk/ask` with an ephemeral conversational buffer that is not household-financial evidence. That packet may project sanitized `forecast.predictedEndingBalance` from the active `Forecast` calendar-waterfall Balance After Deductions (`income − bills − Household Budget`; identity `balance-after-deductions`), sanitized `forecast.paydayAllocation.runningLeftover` plus leftover-consuming `obligations.allocated` / `essentials.allocated` / `extraDebt.allocated` from `Forecast.paydayAllocation` (current-cash allocation picture, not Balance After Deductions), sanitized `forecast.currentPeriodAction.bills` from `Forecast.currentPeriodAction`, and sanitized `planning.trajectory` from `Forecast.baselineTrajectory` (same reprint surface as `public/planning.js`; not gated on `liveOverlay.operatingPlan`), so Talk context and MCP consumers carry the horizon series and Talk can reprint the payday operating picture, leftover, and remaining payday bills without calculating them; Talk Ask does not reprint trajectory in household answers; progressive `text/event-stream` on that same POST emits allowlisted status phases then the same verified body and never Gemini tokens; browser JS does not authenticate to `/assistant/current` or `/assistant/mcp`. `scripts/assistant-mcp.js` exposes the same projection as the read-only `get_atlas_current` MCP tool, alongside the separately authorized Lunch Money tools below (on `POST /assistant/mcp`); `scripts/assistant-oauth.js` is its OAuth protected-resource boundary. MCP accepts only issuer-signed JWT access tokens for the exact resource and `atlas.current.read` scope; the browser cookie, static assistant token, and MCP OAuth still do not unlock one another. The selected external authorization server must issue those JWTs with the exact configured issuer identifier, exact MCP resource audience, expiry, and read scope. Atlas verifies them locally against the configured JWKS and does not introspect opaque tokens. Login, consent, authorization-code + PKCE, client registration, token issuance, and refresh remain with the configured external authorization server. MCP is transport only and OAuth is authentication/authorization only. Neither is a planner, a second Forecast, a copy of household facts, or a transaction store. Unavailable answers stay unavailable. When `liveOverlay.operatingPlan` is unavailable, `get_atlas_current` does not emit a current actionable plan: current cash is labelled dated/non-current, and recommendation / current-period action stay unavailable. Individual projected obligations keep the incumbent Forecast event confidence (`confirmed` / `estimated` / `planned`); grouped obligations (`nextPaymentOut`, near-boundary totals) take the weakest constituent confidence and never promote estimated to confirmed. Never writes. |
| Savings category/tag attribution foundation | `Forecast.savingsLinkTarget` resolves the existing native goal and occurrence against `plan.savingsEarmarks` confirmation history. The existing private provider-account map optionally supplies exact category/tag links, effective dates, mapping version and anchor revision. `scripts/provider-observe.js` resolves them before provider-ID sanitation; Forecast publishes canonical evidence to the existing Savings goal detail. FOUNDATION — NOT COMPLETION: descriptive attribution only, no consumption, household exclusion, Saved/Paid change, settlement relief or funding allocation. Private-map installation and activation remain separate. |
| Savings item ledger (signed spend and remaining need) | `Forecast.savingsItemLedger` (A4a, #820) is the sole authority for an item's signed spending and remaining need, in integer cents: planned L, charges S, refunds R, N = S − R, owner status/amount C, evidenced overlap X, Paid P = N + C − X only when coverage and overlap are established, U = 0 on full owner confirmation else max(L − P, 0), overspend as disclosure, and Still to fund = max(U − A, 0). Its pool core computes F = B − E with need-date shares. `Forecast.savingsLinkTarget.resolve` is the single resolution of a transaction's matched links; `savingsLinkPublication` re-validates direction and history coverage and publishes the unresolved list. `settlementRowRelief` is an adapter to the entry core, and `commitmentPublicationCost` reads it. A4b (#820/#722) enables the effects for native commitment items: `savingsReliefIndex` is the one relief reading (ATLAS-080 settlement evidence plus each linked commitment's ledger P and U) used by every need, cost, cash-event and closing consumer; `classifyCurrentPeriodTransaction` gives exclusive item membership (`savings-item`) to resolved attribution, so item spending leaves Household and Other while pending cash and card liability keep their owners; `savingsCombinedBacking` allocates the pool through the ledger's B/E/F core with E holding only liabilities explicitly reserved from Savings (none has a source yet, so card charges stay with `reconcileCardPurchases`); and the active period's remainder and planned close deduct this cycle's item charges once as `savingsItemSpending`, the close's single owner of those card references. The owner lifecycle (Paid, retirement, owner confirmations from the plan) stays with A5. |

### Budget savings-display amendment — owner direction 2026-09-30

Owner dispatch 2026-10-02 adds the separate **From today** proposal:
`Forecast.recommend.payPeriodViews[].fromTodayFunding` on the active period.
`publishBudgetPeriodFunding` evolves the same `Forecast.simulate` Budget-basis
walk and `Forecast.planSpendPaydayFunding` serial allocator with a dated
current-cash seed. The seed uses evidenced household chequing, remaining
Budget holds after observed consumption, remaining cash obligations and the
existing operating floor. Already-received income is in cash; same-day
scheduled income, proposed recovery injections and unreceived planned-debt
draws are not added to that seed; required planned repayments stay reserved.
Later receipts cannot increase today's contribution capacity. Future periods
retain their Budget income/bill/household capacity and supported payroll horizon.
The original payday publication stays separate and is never reconstructed.
The page reprints contributions, cumulative proposals, remaining requirements,
dated evidence and the first protected gap; later rows stay unavailable and
name that earlier barrier. These remain earmarks, not a ledger, transfers,
actual saved balances, bucket ownership or silver attribution. Missing cash or
spending evidence, unresolved pending cash and overdue protected principal
withhold the proposal. Both canonical household-chequing stocks must be
uniquely known; a live refresh must back both with same-date observations,
including when the opening date does not advance. If a later operating cash
limit disproves earlier proposed earmarks, the entire From today proposal is
withheld with the date, shortfall and existing cash floor; no new allocation
priority is inferred. The existing undated protection and deadline/priority
rules remain in the incumbent allocator. No financial input or write gate moves.

Dale authorized the selected Budget pay-period waterfall to show what each
period proposes to fund and when silver proceeds would be needed. Source:
owner Budget dispatch through ChatGPT, 2026-09-30:

> i also want to see what items we are funding with the surplus in each pay periode so i can see a sort of $400/1200 fusion, or something liek that.

> thanks and in the budget i want it to show me when to use the silver money

> ok i think we can build the app site now i belive you know what i want

Authorize the selected Budget pay-period waterfall to show Forecast-owned
tax/insurance and named planned-cost contributions, with proposed funding
clearly separated from actual saved cash. Forecast alone publishes the totals,
gaps, carry requirement and proposed silver draw. Current Balance remains
Bills-only and is never income. Preserve the existing extra-debt presentation
restriction, existing routes, fail-closed trust, and all data/write/merge/deploy
gates. This amendment does not authorize baseline storage, target changes,
automatic funding, or transfers.

The bounded display may include a named cost's contribution this period,
cumulative proposed funding, separately evidenced actual saved funds, target
cost, remaining gap, due/planning date and destination account. A proposed
silver draw may show its need date, amount, named cost/gap and proposed
remaining bridge balance. Missing amounts, dates, destinations or source
attribution stay unknown; a planning date retains its estimate status.

Implementation must derive from or evolve the incumbent Forecast funding and
cash-walk authorities above. `Forecast.planSpendPaydayFunding` remains the sole
serial allocation authority for its earned scope; this amendment does not claim
that it already publishes a two-pot ledger or silver schedule. Contributions
are earmarks, not a second cost expense: do not deduct a cost payment and its
funding contribution twice or pledge the same opening cash twice. Silver
proceeds already included in a savings balance are not extra income or another
account. Show required operating carry separately; a positive period remainder
is not automatically spending permission.

This is a presentation exception, not a new funding priority or mixed-account
silver attribution policy. A deterministic attribution convention needs its
own explicit owner decision and disclosure; attribution is not bank tracing.
Actual funding requires evidence. Canonical-input promotion, baseline
persistence/versioning, targets, permissions, production writes and transfers
retain their existing gates. Missing Forecast publications require separately
reviewed runtime proof before the page may print them. No financial input,
funding allocation or storage is changed by recording this amendment.

**The 2026-08-16 master-forecast contract is now earned in Forecast.**
Safe-to-spend across the known future is `Forecast.recommend` walking
`Forecast.knowledgeHorizon` and reserving protected principal jointly.
Funding sequence is presentation order; reallocation of freed contribution
capacity is `Forecast.fundingSequence` plus the weekly search. Planned-debt
consequences with a repayment path are `Forecast.plannedDebt` and stay
opt-in. ON TRACK / AT RISK / FUNDING GAP are `Forecast.majorPlans`. A page,
ChatGPT, or Sheet that answers any of them first is the `B73` defect
arriving through a new door.

**The table is not a closed list, and reading it as one is how work goes wrong.**
Three rounds of advisory review added five rows to it that inspection had missed.
So the rule, not the enumeration, is what binds:

- **`data.json` `plan` is the authority for what the engine is told** — the
  obligations, bills, commitments, groups, funding, budget targets, `nextDollar`
  policy, `decisionPosture` policy, `payrollPlanningAssumptions`, and written actions. Changing what the household is *told to do* means
  changing `data.json`, not adding logic that decides it elsewhere.
- **`Forecast` is the authority for what follows from that** — the schedule, the
  projection, the cap, the debt walk, headroom and the budget split. Changing what
  *follows* means changing the engine, where the node suite can prove it.
- **A page script renders; it does not decide.** `renderCalendar()` and
  `renderPlan()` format what they are given.

**Page scripts broke that third rule in the instances `B73` recorded, and those
instances have moved.** The scan for the ones nobody had named ran on
2026-08-12. It read every browser file. The largest instance was the status
band at the top of the Plan page, which selects which of seven verdicts the
household reads and picks two of the dates inside them. The funding-source
cards a few lines below that same band were found by the required review after
the scan had called itself complete. [`BACKLOG.md`](BACKLOG.md) `B73` is the
sole work record for which they were, that they moved, and that the item is
closed. **None of those page-side defects was a row in the table above**: a
page script that decides is an unnamed authority, which is a defect to close,
not an incumbent to register. The rows the moves added name the engine
functions that replaced them.

The recorded instances have been moved into the engine rather than argued away.
The Amanda-transfer deadline: `public/plan.js` re-ran the simulation with her
transfer zeroed and selected the first below-buffer day itself, and
`Forecast.incomeDeadline` now owns that counterfactual. The "Next due" tile:
`public/deepdive.js` used to filter a hand-kept `upcoming` list; `Forecast.nextDue`
now selects from the same `expandEvents` stream the Plan calendar already uses. The homepage
mission: `public/plan.js` chose which instructions the household was given and
composed the sentence, and `Forecast.mission` now owns that selection, returning
the instructions and the figures behind them while the page keeps the wording.
The May 2027 renewal: `public/modellers.js` compounded the HELOC, totalled both
sides' interest and compared the result against today's household cash, and
`Forecast.renewal` now owns all of it — including the amortised payment, which
had been sitting in `public/app.js`, the shared page core, where it decided a
household-facing figure outside the suite's reach. The payoff modeller:
`public/modellers.js` solved the annuity behind its "clear in 5 / 3 / 1 years"
presets and picked its own slider floor, on top of `payoff()` in that same page
core, and `Forecast.payoffDebts` / `Forecast.payoffModel` now own which debts may
be modelled, what each owes today, the rate convention each is charged under, the
minimum a larger payment is measured against, and the projection itself. The
status band and the funding-source cards, which moved together because they read
one result: `public/plan.js` re-derived `fundingShort`, hand-copied the engine's
buffer comparison and its EPSILON as `sim.min.balance < sim.buffer - 0.005`,
selected which of seven verdicts the household read, walked the daily balances
for the first breach and the first negative day, totalled the funding parts, and
a few lines below asked `o.available >= needed` about each source in its own
arithmetic. `Forecast.planStatus` now owns the verdict and both dates, and
`Forecast.recommend`'s funding result owns the per-source coverage — so the two
cannot disagree, which they had. The Deep Dive derived totals: `public/deepdive.js`
grouped and totalled `heldElsewhere`, averaged a period's spending, totalled
discretionary spend and avoidable fees, flagged Cash Back Visa cycles with a
page-side `26.99` and a ±4pp band, summed the implied and charged columns, and
hardcoded `~$1,620/month` for the mortgage, and `Forecast.deepDive` now owns
all of it — the card rate from the Cash Back Visa record, the incumbent `>`
band, and `monthOfAnnual` on the mortgage's `annualInterest`, the same twelfth
`compactSnapshot` uses. The published HELOC history chart used to draw a
hand-maintained current endpoint from `data.helocHistory` beside a different
live `debts.heloc` opening; `Forecast.deepDive` now composes that series from
the monthly observations plus the current debt record, and the page holds
the wording. In each
case the page renders the returned result and a focused test reconciles the move
against a hand-computed case.

**This section used to say "no page script is known to break it", and the scan is
why it no longer does.** A running count of moved, remaining, and page-side
items used to live here and drifted every time an instance moved, which is why
it is gone rather than updated — [`BACKLOG.md`](BACKLOG.md) `B73` owns that
record. Moving an authority out of a file does not clear the file — the payoff
modeller was still deciding in `public/modellers.js` after the renewal moved
out of it, and a `public/plan.js` instance was missed by the scan itself and
caught by the review. The recorded `plan.js` and `deepdive.js` instances moved.
The absence of a known instance was never evidence that none existed, and
searching is what settled the recorded set.

Anything not named above belongs to one of those three rules, or is that defect.
If it is genuinely unclear which, that is a question for the required review —
never a licence to stand up a fourth answer.

Four of those rows carry a trap, and each is recorded rather than smoothed over.

**The cap and the next move are two authorities, not one.** `recommend` computes
the cap, the gap and the funding result; the instruction the household actually
reads is authored by hand in `data.json` `plan.actions` and rendered from
`plan.actions[0]`. They were one row here until an advisory review split them —
which matters, because a later change to the recommender that leaves the written
action untouched would move the figures under an instruction that no longer
matches them, and nothing would notice.

**`Forecast.recommendWeekly` is not a co-owner of the weekly cap.** It is the
solver `recommend` calls, and on an opening-gap plan it returns `0` while
`recommend` funds the gap and re-solves for the cap the household can actually
afford. When even zero spend cannot keep the protected plan feasible,
`recommendWeekly` still returns `0` and `recommend` returns `mode: infeasible`
rather than publishing that zero as a feasible cap. `forecast.js` calls
`recommend` *the* single authority in its own words.
A page reading the solver directly is precisely how `$1,650/wk` and `$0/wk`
shipped on the same screen — so later work consumes `recommend`, never the
solver beneath it.

**The renewal comparison is `Forecast.renewal`'s, and it opens on the same debt
state as everything else.** It reads balances through the shared
`openingBalance` rule — posted plus pending, the rule the debt walk opens on and
headroom is measured against — and takes today's household cash from
`plan.obligations`, so the HELOC's $0.00 of cash is derived from its `nonCash`
charge rather than asserted, and a change to the mortgage payment moves the
comparison the household reads. `data.json` `mortgage` keeps the renewal's
standing facts (maturity, remaining years, prepayment room) and is no longer a
second home for the balance, rate, or bi-weekly payment the arithmetic and the
slider open on. What is left in the page is
wording, colour and layout.

**A quoted rate is not a number on its own, and the renewal used to treat it as
one.** Canada prices the two mortgage products on different compounding: a fixed
rate is quoted "calculated half-yearly, not in advance", a variable rate
compounded monthly. The modeller applied the monthly convention to every rate its
slider could reach, including the fixed quotes TD's April 2027 offer letter will
carry. On TD's own published example — $300,000 at 3.00% — that is $2,071.74 a
month against a true $2,069.07 over 15 years; on this household's balance at
3.64% over 18 years it overstated the payment by $7.57 a month and $1,634.99 over
the term. `RATE_BASIS` now holds both conventions and `Forecast.renewal` **requires**
the caller to name one: there is deliberately no default, because a default is
the assumption again with better manners. The page makes it a household choice
and never prints a rate without its convention. The HELOC keeps its own — it is
prime-linked whatever the mortgage renews into, so choosing fixed must not
reprice the facility sitting beside it.

**The schedule has one owner.** Dates, amounts and recurrence are
`Forecast.expandEvents`'s, from the `plan` inputs. `renderCalendar()` only
formats the `sim.events` it is handed. The exported `.ics` derives its
cash-payment VEVENTs from that same expander over a longer horizon; statement
closes, tax deadlines, the mortgage-renewal countdown and the HELOC contractual
21st remain reminder-only look-points and are tagged so they cannot be read as
chequing outflows. A
hand-kept `upcoming` list used to be a third schedule; it is deleted. Paid
forensic notes live in `data.json` `settled` as an overlay and do not decide
what is due. A commitment that has already been paid keeps its dated
`plan.commitments` row and records that fact as `settledOn`. Forecast
omits the future cash event only when `settledOn` is on or before the
simulation start.

**Owner payment confirmations (A5, #819).** This is the one home for both
fields. `settledOn` is the owner's *full* confirmation and its date is the
confirmation date, never a payment date. `ownerPaid: { amount, confirmedOn }`
on a dated point commitment is the owner's *partial* confirmation. It is valid
only when 0 < `amount` < the planned `amount`, `confirmedOn` is a
`YYYY-MM-DD` on or before the opening, and the row has no `settledOn`.
Anything else is no confirmation: the row stays unpaid with its full need
(fail closed), and so does every reader that does not know the field.
`Forecast.commitmentOwnerPaid` is the sole reader. It joins the shared relief
reading (`savingsReliefIndex` → `settlementRowRelief`, or the item ledger's
owner input C for a linked item), so need, the cash event, backing and the
published cost all move together and count the paid part once. Remaining =
planned − owner amount, and a partial never closes the item. Owner cents beside
linked transaction cents, with no evidenced overlap, make Paid Unknown rather
than a sum. On the Budget page a fully confirmed item stays listed for the rest
of the pay period holding its confirmation as Paid, labelled owner-confirmed,
with its actual amount and date Unknown. That listing is a display row only,
with no need, share or cash event, and the item is absent from the next
opening on. Both fields are written only through the existing owner-word
route to `data.json`. They are owner-confirmed facts, never
transaction-verified, and they change no verified / calculated / estimated
tag. The planned-input edit contract refuses to correct or remove a row
carrying either field.

**HELOC cash minimum and month-end capitalise are two facts.** Owner-stated
2026-09-18: Forecast models the planned HELOC cash minimum from the encoded
`plan.obligations` id `heloc` fields `cashPayment` / `cashDay` /
`cashFirstDue` (~$814.18 on the 21st from 2026-09-21) as an
`expandEvents` cash obligation (`kind: obligation`, `effect: payment`).
That cash is Forecast month **Required debt payments**
(`baselineTrajectoryMonthFunding` stage1.obligations), not Forecast Bills.
Month-end interest remains `nonCash` / `effect: capitalise` on day 31 and
is not a chequing outflow. The cash walk deducts the `cashPayment` path
once; it does not also deduct the capitalise row. A represented prepaid
cash-minimum date is omitted from that cash walk exactly once and is still
applied on the coupled `projectDebts` walk for a dated opening. Remaining August 2026
cash is still $0 additional (Q19; `cashFirstDue` 2026-09-21). Lunch Money
extras around $1,000 are evidence of irregular overpayment, not the
standing encoded amount. The Credit page still keeps `nextCapitalise` and
`nextCashMinimum` as two facts from that same `capitalisingCashMinimumOccurrences`
rule. The Plan bills list prints the cash minimum once, de-duped against
the expandEvents cash event. Keep-separate `Forecast.renewal` applies that
same `monthlyCashFor` cash minimum against the capitalising HELOC balance;
unpaid compounding remains the path with no declared cash payment.

**Current-state refresh uses Lunch Money as the normal feed; Forecast stays
the engine.** Owner decision **2026-08-17**: Lunch Money is the household's
normal operational financial update feed. Forecast remains the deterministic
financial engine and the sole planning / calculation authority. Lunch Money
is evidence, not the planner, not canonical household policy, and not
authority over future commitments, priorities, or owner decisions. The live
read-only GET seam (`scripts/provider-observe.js`) is an **incumbent** and
has already been exercised. `scripts/reconcile.js` is the non-writing
compare. **T4 passed 2026-08-17.** `scripts/canonical-refresh.js` is the
earned preview / approve / bounded-write path. **Unattended production
writes are not approved.** B91 is done. Direction, not a schema:

- freshness belongs to the evidence class (live balances, contractual
  recurring facts, household policy, derived engine results), not merely one
  typed `meta.asOf`;
- a live opening observation needs cutover / as-of semantics so events
  already represented in that observation are not replayed;
- Forecast schedule is authority for what *should* happen; settlement
  evidence is authority for what *has* happened;
- account/statement balance, past-due amount, current amount due, and due
  date are distinct;
- “is this a household obligation?” and “which account pays it?” are
  distinct;
- posted balance, pending, limit, and available credit are distinct, and
  available credit is never cash;
- an account balance is not automatically spendable household cash;
- reliable salary, coaching net economics, and transfers must not share one
  income authority;
- `Forecast.recommend` is the mathematical maximum under the protected
  floor, not an operational household target unless owner policy exists.

Do **not** satisfy this gap with a database, second canonical store, generic
fact schema, workflow engine, event sourcing, classification registry,
provenance graph, staging platform, generated `data.json`, `plan.proposals[]`,
a `source` object on every numeric leaf, a second payday or budgeting engine,
or leaf-level provenance. Existing interviews, open questions, and dated
owner policy remain enough for household intent. Preferred shape, when built:
existing observation record → one canonical pointer into `data.json` →
comparison → owner-approved canonical edit → Forecast. The first B91 slice
adds the non-writing compare (`scripts/reconcile.js`) and the
`representedEvents` cutover on `Forecast.expandEvents`. The D3 slice adds
`settledOn` on a dated commitment and settlement observations against that
field. The D4/D5 slice adds Hydro observations
(`docs/reconciliation/utility-observations.json`) that distinguish an
informational account balance from dated `plan.bills` dues, and paying-account
attribution from household-obligation status. Live Hydro canonical state is
unchanged. The D2 slice adds Amanda-income observations
(`docs/reconciliation/amanda-income-observations.json`) that distinguish
Tennis BC salary deposits, coaching/business inflows, business
obligations, household transfers, and household-available remainder.
Owner-confirmed 2026-08-22: the two fixed Tennis BC salary deposits
(`plan.income.amandaSalary15` $2,168.85 on the 15th and
`plan.income.amandaSalaryMonthEnd` $2,387.99 on month-end) are Forecast
household income. Owner-clarified 2026-08-31 / restated 2026-09-01: they
first land in TENNIS INCOME, which is not Current Balance; household-visible
posting proof is the later transfer into BILLS ACCOUNT. The retired
`amandaTransfer` estimate is not a second income line. That BILLS transfer
proves a posted occurrence and is not a second Forecast inflow.
Coaching/business receipts are not forecast. Unknown
business obligations fail closed and do not invent a remainder. The raw
TENNIS INCOME balance remains non-spendable coaching/business remainder
(Q25). Live Amanda income canonical state uses those two salary streams.
The retired $1,100 standing Amanda-transfer action is not a live
household instruction. The D8 slice adds card-state
observations (`docs/reconciliation/card-state-observations.json`) that
distinguish posted balance, pending, limit, available credit, and
confirmed payment. Limit and available credit are never household cash.
Unknown pending is not $0. A scheduled minimum is not a confirmed posted
payment. Live card balances, limits, pending, and payments are unchanged.
Owner decision 2026-10-07: an exact, card-specific minimum-payment category
assigned in Lunch Money may confirm household minimum-payment purpose and the
payment action. The read-only observer requires the approved leaf category and
transfer exclusions, a posted native-CAD debit from the declared funding account,
payment identity and one uniquely eligible cycle. Forecast alone determines
amount satisfaction against the confirmed minimum. This is household category
confirmation, not an invented issuer posting or a promotion of estimated minimum
or due-date inputs. Generic transfers, purchase backfills, pending and ambiguous
evidence cannot qualify. Current category evidence is rebuilt on each observation;
recorded owner confirmations retain precedence. The exact protocol and independent
proof are in [MINIMUM_CATEGORY_CONFIRMATION.md](docs/proof/MINIMUM_CATEGORY_CONFIRMATION.md).
This decision authorizes this bounded read-only consumer, not Lunch Money category,
rule or transaction writes, canonical refresh, a new planner or a store.
The later pending-transaction slice lets `scripts/provider-observe.js`
derive a mapped revolving-credit pending observation from Lunch Money
transactions, including the 2026-08-16 Bell Mobility $250 Travel Visa
fixture. That observation is evidence. It does not write `debts[].pending`.
The D7 slice adds posting observations
(`docs/reconciliation/posting-observations.json`) that compare whether a
scheduled occurrence has posted against `plan.opening.representedEvents`.
Forecast remains authority for what should happen; posting evidence is
authority for what has happened. Unknown posting is not posted and is
not unposted. Live `plan.opening` is unchanged. The D11 slice derives
`Forecast.recommend.nearBoundary` from existing `zero.events` (next
payday date through the following calendar day) and has `Forecast.mission`
name those joint-cash obligations before surplus-use guidance. It does
not add a horizon, change the weekly search, or write `data.json`. Those
slices did not finish B91 by themselves. Sequencing and the Aug. 14
payday acceptance corpus live in the build strategy and
[`docs/source_intake/PAYDAY_ACCEPTANCE_2026-08-14.md`](docs/source_intake/PAYDAY_ACCEPTANCE_2026-08-14.md).
The later current-state cutover wrote the 2026-08-16 Forecast opening
from the Lunch Money observation plus same-day card screenshots, kept
Fusion camp/tryouts `settledOn: "2026-08-14"`, and kept the 1 September
Hydro dated due. It does not invent Aug. 14 joint-cash opening balances,
does not resolve Q19, and does not encode $600/week. Observation files
remain evidence; the reconciler remains non-writing. B91 is done.
A later successful refresh writes posted current-state fields into
`data.json` only through `scripts/canonical-refresh.js` after an explicit
preview approval. `scripts/snapshot-balances.js` remains the dated-history
writer after a successful as-of cutover and is not a second current-state
authority. That snapshot write does not change Forecast inputs. Unattended
production writes from Lunch Money are **not** authorised.

**`plan.cancelledServices` is the owner-confirmed cancelled-service identity
list as of 2026-09-21.** It is not a bill roster and creates no Forecast event.
`Forecast.classifyCurrentPeriodTransaction` is still the sole transaction
classifier: only an eligible posted debit dated after a service's recorded
confirmation boundary enters the incumbent Other Spending actual once and
carries `unexpectedStatus: cancelled-service-charge` through Forecast recon to
the existing Plan transaction drill-down. Pending rows, same-day or earlier
history, unlisted merchants, and active subscriptions do not inherit the
status. Provider observation remains read-only and keeps its generic
pending-to-posted identity rules; the page renders the Forecast status and does
not classify or alert independently.

**`plan.nextDollar` is owner-stated as of 2026-08-24.** After required payments,
essential spending, incumbent liquidity protection, and required or known future
costs are protected, true surplus goes to extra debt before optional future costs
or additional discretionary cash accumulation. Among eligible revolving cards
and the HELOC, highest known interest rate wins. `Forecast.debtPriority` applies
that policy to current facts. Equal or unavailable rates publish no target until
the owner supplies a tie-breaker; the page does not invent one. Null, missing,
or non-finite eligible balances also publish no target — `Number(null)` is not a
cleared facility. Unknown pending on a positive posted balance is not $0 pending:
extra principal may use the proven posted exposure, and leftover cash is held
rather than sent to a lower-priority target or optional residual.

**`plan.decisionPosture` is owner-stated as of 2026-09-14.** Get to the financial
goal as fast as possible without making the household so tight the plan becomes
unrealistic or forces re-borrowing. Velocity (fastest to goal) and Resilience
(enough cash and flexibility for real life plus known commitments) are distinct
dimensions. The posture is aggressive, but not brittle. Breathing room is enough
slack to stay sustainable and reduce immediate re-borrow risk — not waste
permission, comfort-max, avoiding hard choices, or slowing without a demonstrated
resilience reason. Known authorized future commitments exert gravity.
Mathematically cheapest is not the best household decision when that cheapest
path is unacceptably brittle. No universal numeric breathing-room threshold is
recorded. Forecast does not apply this row in this slice.

---

## The gated capabilities

Each is **wanted** and **not yet permitted**. The gate is the whole rule: until
it is met, the capability is not started, and a plan that schedules it earlier is
wrong rather than persuasive. **Passing a gate is an owner decision, recorded** —
never an agent's judgement that the moment has come.

### A canonical transaction and history store

**Gate.** A store may be introduced when the current batch-derived foundation —
`data.json`, generated `public/periods.json`, and git as the history — can no
longer provide the **invariant, identity or idempotency** guarantees the work
needs, and that failure is **demonstrated on real household data rather than
predicted**.

**Candidate if the gate is met.** SQLite, as the smallest thing giving identity,
foreign keys, uniqueness and idempotent import without an operated service. It is
**not mandatory and not pre-authorised** — it is the current preferred minimal
answer *if* a store is earned at all. Postgres needs its own evidence.

**Not this store (owner decision 2026-11-06, PR #831 comment 6694409045).** The
private period-history archive may use an owner-provisioned hosted Postgres
(Neon Free) holding only its sanitized per-period projection
(`docs/PRIVATE_PERIOD_HISTORY.md`). That approval is for that archive alone; this
canonical-store gate is unchanged.

**Not a reason to open it:** that a plan says so, that relational modelling would
be tidier, or that a later capability assumes it. Until the gate is met, **files
remain the right tool** — they give history, diffs and versioning for free, and a
store would only add failure modes.

### Automated financial-data connectivity

Lunch Money as the **normal operational update feed** is owner-approved
product direction (2026-08-17). That direction does **not** authorize bank
credentials in Atlas, money movement, autonomous institution changes, silent
production writes, bypassing reconciliation, or treating unknown or stale
values as current.

Two capabilities must not be conflated:

- **Live read-only observation** — already built and exercised.
  `scripts/provider-observe.js` may GET Lunch Money when
  `LUNCHMONEY_ACCESS_TOKEN` is set, or on the owner's Windows home PC when
  the CurrentUser DPAPI blob described under **The secret boundary** is
  present. Production on-demand GET from Render is owner-authorized
  2026-08-23. That seam does not write `data.json` and does not store a bank
  password.
- **Trusted canonical refresh** — owner-passed **2026-08-17** (T4).
  `scripts/canonical-refresh.js` is the earned preview / approve / bounded
  write. Automatic or unrestricted production writes and scheduled refresh
  remain **not** approved. A production Lunch Money token is authorized
  for on-demand GET-only observation (2026-08-23) and, as of 2026-09-04,
  for the two `category_id` grants recorded on that production pass: the
  exhausted one-transaction correction, and the later reusable Household
  Budget → Other Spending class. Neither grant makes the token a general
  Lunch Money write credential or a canonical write path.
  The T4 pass record is
  [`docs/connectivity/T4_OWNER_PASS_2026-08-17.md`](docs/connectivity/T4_OWNER_PASS_2026-08-17.md).
  The production read-only pass is
  [`docs/connectivity/PRODUCTION_LIVE_READONLY_OWNER_PASS_2026-08-23.md`](docs/connectivity/PRODUCTION_LIVE_READONLY_OWNER_PASS_2026-08-23.md).

Pointing **unattended production** writes at the live feed remains gated
on owner authorization that the T4 pass and the 2026-08-23 read-only
pass did **not** grant. The five connectivity conditions and the
2026-08-17 owner pass earned the local preview/approve writer. The
2026-08-23 owner pass earned production on-demand GET-only observation.
The 2026-09-04 addenda on that same pass authorize the exhausted
one-transaction `category_id` correction and the later reusable Other
Spending `category_id` class, and do not reopen any other Lunch Money
write:

1. **proven need** — recorded: the owner will not maintain the same current
   account data twice via Lunch Money and a separate routine statement import;
2. **current Canadian availability** — a provider that actually serves these
   institutions, verified when the work starts, not assumed;
3. **security review** — owner-reserved, and unchanged by anything here;
4. **provider semantics** — how it identifies accounts, transactions, pending
   state and corrections, and what its failure modes cost;
5. **a working canonical ingestion foundation** — idempotent import and
   identity proven **before automatic canonical writes are pointed at the
   live feed**.

Condition 5 is about trusted writes, not about building the foundation, and
not about the existing read-only GET: the foundation may be built first, and
doing so satisfies one condition rather than opening the gate. The existing
live Lunch Money GET is an incumbent. Trusted canonical refresh through
explicit owner approval is earned (`B81` / `AF-LIVE-02`). Unattended
production writes remain owner-reserved. A production Lunch Money token
is authorized for on-demand GET-only observation (2026-08-23) and, as of
2026-09-04, for the two `category_id` grants recorded on that production
pass: the exhausted one-transaction correction, and the later reusable
Other Spending class. Neither grant is a canonical write path.

**Current seam.** Owner instruction 2026-08-16 recorded condition 1 and
authorised a fixture-first observe path. The 2026-08-17 feed direction
names Lunch Money as the normal feed. The later 2026-08-17 owner pass
opens T4 for the earned preview/approve writer only. The 2026-08-23
owner pass authorizes a production token for on-demand GET-only
observation. The 2026-09-04 addenda on that pass authorize the exhausted
one-transaction `category_id` correction and the later reusable Other
Spending `category_id` class. Every other Lunch Money interaction
remains GET-only. Unattended production writes remain unauthorized.

**Authorized Lunch Money `category_id` corrections.**
Two owner grants, both recorded on the 2026-08-23 production pass. They
are not the same grant. The exact text lives on that pass; this section
states the gate.

1. **One-transaction grant (2026-09-04, PR #248).** Atlas may perform
   the one `category_id` correction the owner already granted on the one
   owner-identified Lunch Money transaction. That grant is exhausted by
   that one write. It is not a standing class.
2. **Reusable Other Spending class (later 2026-09-04 owner decision).**
   Atlas may update `category_id` on one exact Lunch Money transaction
   when an authenticated household user (Dale or Amanda) selects an
   existing Lunch Money category from Household Budget → Other Spending
   and explicitly confirms that individual change. This is a standing
   authorization for repeated manual use of that same narrow operation.
   It is not exhausted after one successful write. Each invocation
   remains one transaction, one existing category, one explicit
   confirmation, and `category_id` only.

Neither grant is a general Lunch Money write credential, a canonical
Atlas write path, a second transaction ledger, or Forecast policy.
Amount, date, payee, merchant, notes, balance, transfer, payment,
account, category-create/delete/rename, merchant-wide, bulk, automatic,
AI-triggered, Gmail-triggered, and unattended writes remain forbidden.
Fuzzy targeting by merchant, amount, date, description, or category is
not authorized. The final provider write must target one exact Lunch
Money transaction ID through server-side identity resolution.
Browser-visible aliases such as `tx-*` must not expose raw provider
transaction IDs. The selected category must already exist and must be
validated server-side against the provider’s current category set.

**Confirmed-write flow.** After Lunch Money confirms a successful
`category_id` write, Atlas returns to the incumbent GET observation /
live overlay. Forecast recomputes from observed state. The Household
Budget UI refreshes from that Forecast result. Atlas must not keep a
competing local transaction ledger, must not recategorize locally as a
substitute for the provider write, and must not mutate published
financial state before that confirmation. If Lunch Money rejects the
update, the transaction and totals stay unchanged and the user sees a
failure. Lunch Money remains the transaction source of truth. Forecast
remains the sole planner and calculation authority. This section
records the grants; it does not add a write seam.

---

## The secret boundary

### Owner-dispatched private card-payment choice foundation (2026-10-12)

**FOUNDATION - NOT COMPLETION.** Dale approved an explicit posted-payment
purpose and exact purchase-selection workflow. The first bounded slice is
`scripts/card-payment-decision-store.js`, one typed private intent store, and
`scripts/card-payment-decisions.js`, its prepare/confirm/outcome controller.
It has no production importer, routes, environment configuration or UI.
Injected adapters supply an authenticated household-session identity, existing
provider evidence and explicitly resolved choices. They supply no matching policy.
`Forecast.validateCardPaymentDecision` delegates qualification to the incumbent
reconciler and card-movement publication; no second calculator is introduced.

One explicit confirmation atomically records the choice and its operation
receipt against the preview revision. Lost replies require outcome verification;
unknown outcomes are never automatically retried. Revision/evidence changes
reject instead of rebasing. Stored intent survives absent or changed evidence,
which withholds current qualification. Private references never appear in previews
or receipts. Evidence loss never retires payment-leg or purchase-cent claims.
Preview, confirmation and current requalification validate the complete retained
cohort through Forecast's incumbent aggregate bounds, including unavailable records;
independent partial allocations remain permitted when their total fits.
The inactive v2 store preserves immutable original and successor choices and
operation receipts. Version-1 `replace` / `retract` commands name the exact
current saved choice and preview revision; replacement keeps the same payment
pair and revalidates the successor against every other effective retained claim.
Retraction withdraws interpretation, never reverses bank money. Only an explicit
confirmed correction/withdrawal releases its predecessor's claims; missing
evidence never does. A withdrawn head may be restored only through a newly
qualified replacement. Superseded heads cannot fork. Identical operation retries
recover the original outcome; conflicting payloads cannot reuse an operation ID.
An uncertain write retains its in-process preview for explicit retry after
outcome lookup and fresh validation; a restart cannot reconstruct an unknown
preview or automatically apply it.

Existing v1 documents remain readable but cannot be written until an explicit
revision-and-document-digest-bound migration atomically installs v2 with the exact
original v1 bytes retained inside it. No household migration is performed by this
foundation. Missing/corrupt/unsupported data is never treated as empty. A rollback
reader that cannot read v2 must withhold the entire dependent input, never fall
back to the preserved v1 bytes after newer operations. Orphan-lock recovery and
restoration from backups require separately reviewed recovery; neither is automatic.
Unknown historical opening stays unknown; another unresolved card
keeps global coverage unavailable; household payment purpose does not establish
issuer minimum satisfaction. Canonical data and financial providers are untouched.

The explicit file adapter follows existing private POSIX conventions: a dedicated
owner-private directory outside every repository/worktree/static path, no symlinks,
exclusive locking, file sync and atomic replacement plus directory sync. Missing,
corrupt, unsupported or locked state fails closed. It changes no permissions and
does not reuse cleanup grants. Orphan locks require separately reviewed recovery.
Windows filesystem security/durability and production Render storage are unqualified.
Synthetic process-restart proof is not production restart/redeploy qualification.

The next integration PR is the live consumer/closure step: default-disabled
session routes, shared browser/assistant input revision before observer history
selection, bounded saved-reference lookup, ordered refresh and a panel-body form.
It must prove that path end to end. Production activation remains reserved until
durable storage, single-writer operation and restart/redeploy behavior are qualified;
this foundation grants no infrastructure, credentials, access, provider writes or
generic canonical transaction store.

The line is between a secret that lets something **log in as the household** and
a secret that lets a server **read data it has been granted**. "No credentials"
is the wrong rule and was never true here — the server refuses to start without
`SITE_PASSWORD` and `SESSION_SECRET`.

### Absolute — no gate, not a tier

- a bank or institution **username or password**;
- a **PIN**, a security answer, or a one-time / 2FA code;
- any credential intended for **direct interactive login** to an institution;
- any **automated action against an account** — a transfer, a bill payment, an
  application, a setting change, a form submission, an agreement acceptance or
  an approval.

Atlas reads and publishes. Nothing below opens this list for a bank or
other financial institution. The 2026-09-04 Lunch Money exceptions are
not bank actions: they authorize only the exhausted one-transaction
`category_id` correction and the later reusable Other Spending
`category_id` class, on the evidence feed, as recorded on the
production-pass addenda. They do not authorize transfers, payments,
amount edits, or any other provider write.

**Fail closed on ambiguity.** If a credential could authenticate Atlas *as the
household* through an institution's ordinary consumer-login path, treat it as
prohibited and **stop** — do not weigh it, do not proceed on the reading that
permits it. An enumeration fails open on the category nobody thought of; this
rule does not, and it is deliberately the catch-all rather than the list above.

### Gated — may be permitted later, not permitted now

Provider or API **service credentials**, and OAuth access or refresh tokens, for
**read-only** data access. The T4 pass permits the local Lunch Money GET-only token:
`LUNCHMONEY_ACCESS_TOKEN` in the owner's shell, or the Windows CurrentUser
DPAPI blob under **Where a secret may live**. The 2026-08-23 owner pass
permits that same token in Render for on-demand authenticated
`/data.json` observation. Atlas usage remains GET-only except the two
2026-09-04 `category_id` grants recorded on that pass — the exhausted
one-transaction correction and the later reusable Other Spending class —
even though Lunch Money personal tokens are not provider-scoped
read-only. Neither grant is a general Lunch Money write credential.
Never for anything on the absolute list. Unattended production writes
remain not authorised. The token does not become a general-purpose
Atlas write credential.

The owner decision of 2026-08-29 separately authorises only the OAuth
infrastructure required to connect ChatGPT to Atlas's incumbent read-only
assistant packet. Atlas is the OAuth protected resource, not an authorization
server: it may validate an incoming short-lived issuer-signed JWT access token
for the exact MCP resource and `atlas.current.read` scope, then discards it.
Opaque access tokens are not supported and Atlas does not introspect. It does
not issue, refresh, persist, log, or return that token and does not add an
Atlas user store.
The external authorization server owns login, consent, client registration,
authorization-code + PKCE, token issue, and refresh. This authorises no provider
write, canonical write, financial action, second planner, or broader identity
platform.

### Where a secret may live — the canonical rule

**This is the one home for this rule.** Other documents defer to it and must not
restate a narrower or wider version.

**Two kinds of secret, and the rule differs.** A **configured secret** is one
Atlas is given and holds: `SITE_PASSWORD`, `SESSION_SECRET`,
`ATLAS_ASSISTANT_TOKEN`, `ATLAS_TALK_GEMINI_API_KEY`, and — only if the
connectivity gate is ever passed — a provider, API or OAuth credential. A
**session credential** is one the server *issues* to a browser after a successful
sign-in: today the signed, expiring `hfd_session` token. Everything below about
where a secret may live governs **configured secrets**; the session credential is
covered separately at the end, and the two must not be conflated.

An incoming OAuth access token on `POST /assistant/mcp` is a transient request
credential, not a configured Atlas secret and not an Atlas-issued browser
session. It exists only in the `Authorization` header long enough to verify it is an
issuer-signed JWT whose exact issuer identifier, signature/JWKS,
audience/resource, expiry/not-before, and read scope match. Atlas does not
introspect opaque tokens. It is never stored, logged, returned, or forwarded
into the assistant packet.

A configured secret lives in exactly one of:

- **production** — the deployment platform's environment secrets, which is Render
  today; the platform's mechanism matters, not the provider's name. A Lunch Money
  token in Render is authorised for on-demand live observation (2026-08-23)
  and, as of 2026-09-04, for the two `category_id` grants recorded on
  that production pass: the exhausted one-transaction correction, and
  the later reusable Other Spending class. Neither grant is a general
  Lunch Money write credential. The token remains server-side and is
  never published to the browser. The provider-account map reaches production as
  `ATLAS_PROVIDER_ACCOUNT_MAP_JSON`, the same `atlas-provider-account-map/v1`
  schema, never as a second mapping authority. The read-only assistant
  surface uses `ATLAS_ASSISTANT_TOKEN`, a dedicated Bearer secret distinct
  from `SITE_PASSWORD` and from the browser session. Talk uses dedicated
  `ATLAS_TALK_GEMINI_API_KEY` for Google Gemini (`gemini-2.5-flash-lite`) on
  session-only `POST /talk/ask`. Unset → Talk answers stay unavailable. It
  must not reuse `SITE_PASSWORD`, `SESSION_SECRET`, `ATLAS_ASSISTANT_TOKEN`,
  Lunch Money, MCP, Grok, or any other existing secret. The MCP protected resource
  instead uses non-secret configured endpoint identifiers
  (`ATLAS_MCP_RESOURCE_URL`, `ATLAS_OAUTH_ISSUER`, `ATLAS_OAUTH_JWKS_URI`) and
  validates transient incoming access tokens; it stores no OAuth token.
  Unattended canonical writes remain not authorised;
- **local development** — an environment variable in the developer's own shell.
  That is how `SITE_PASSWORD`, `SESSION_SECRET`, `ATLAS_ASSISTANT_TOKEN`,
  and `ATLAS_TALK_GEMINI_API_KEY`
  are supplied when running locally, exactly as `README.md` documents, and it
  remains the override for `LUNCHMONEY_ACCESS_TOKEN` (CI, tests, and advanced
  local use);
- **the owner's Windows home-PC Lunch Money GET-only store** — a CurrentUser
  DPAPI-encrypted file at `%LOCALAPPDATA%\Atlas-Financial\secrets\lunchmoney.dat`,
  decryptable only in that Windows user context, outside the repository.
  Bootstrap is `node scripts/local-credentials.js setup-lunchmoney`. An existing
  blob is not replaced unless `--replace` is passed. Removal is
  `node scripts/local-credentials.js remove-lunchmoney`. Non-Windows processes
  and remote/cloud agents do not read or emulate this file. This is not a
  Render token, not a GitHub Actions secret, and not a cloud secret store;
- **an encrypted server-side store**, if — and only if — a future approved
  provider needs a secret **persisted and rotated** rather than set once, which
  an environment variable cannot do. This exists so OAuth refresh rotation would
  not require inventing a second rule later. Not authorised today. The
  Windows DPAPI file above is not this store.

And a configured secret goes **never**: into source control, into `data.json`,
into `.env`, into a script, into a command line, into a pull request, into a
log, into GitHub Actions, or into the browser in any form — not in JavaScript,
not in `localStorage` or any cookie, not in a file the page fetches, not
embedded in markup. **No configured secret is ever stored client-side**, and
nothing below relaxes that. The Windows DPAPI blob is ciphertext outside the
repository; it is not a second copy of the plaintext token.

#### The session credential

`server.js` issues `hfd_session` after a correct password: a token signed with
`SESSION_SECRET` and carrying its own expiry. It is **permitted in the browser**,
and in exactly one form — an **`HttpOnly` cookie that page JavaScript cannot
read**, `SameSite=Lax`, and `Secure` whenever the request is HTTPS. Not in
`localStorage`, not in a readable cookie, not in a URL, not in markup.

That is the deployed gate, and this paragraph aligns the rule with it rather than
authorising anything new. **It grants nothing else**: no provider, API or OAuth
credential may be stored client-side under it, and it does not touch the absolute
prohibitions above on institution login credentials or automated account actions.

Two earlier drafts of the prohibition were wrong in the same direction, and review
caught both. The first read "client-side in any form the browser can read" and
outlawed Atlas's own sign-in page — the household typing the shared password is
the secret being *used*, over HTTPS, and the server never sends it back. The
second banned "browser storage" outright and outlawed the session cookie that same
page sets. The defect each time was writing a prohibition before saying which kind
of secret it governs, which is why the distinction now comes first.


### Owner addendum — direct Lunch Money ChatGPT access (2026-10-02)

**Owner continuation 2026-10-09 — inactive routine-cleanup implementation.**
Dale explicitly dispatched #560 to extend the bounded standing authorization
to supported names, existing categories, additive notes/tags and evidence-backed
transfer labels: make eligible corrections under an exact signed reusable
instruction, then report them, without per-transaction approval. Preserve bank
descriptions and existing notes/tags, prove no unintended effect through the
incumbent observer/Forecast, and durably log before/after for a private history
sheet. Keep uncertain cases unresolved. No amount, split, deletion or money
movement on this path. The implementation is separately versioned; existing
category grants gain no permission. Lunch Money remains transaction authority
and Forecast remains planner/classifier. This authorizes construction and
synthetic tests only: everything stays off until tests, independent Systems
Review and final access/provider-contract/private installation/sheet setup are
complete and approved. No production write, access grant or deployment is
authorized here. [The bounded connection contract](docs/LUNCHMONEY_CLEANUP_CONNECTION.md)
records the live consumer, proof and exact activation prerequisites.

The owner explicitly requested transaction discussion and edit capabilities in
Atlas Financial's existing ChatGPT plugin. This extends the earlier packet-only
OAuth grant solely for on-demand ledger catalog/lookup and confirmed single
transaction category/notes corrections or splits that conserve the parent amount.
Lunch Money remains ledger authority and Forecast remains planning authority.
Selected transaction payees, notes, dates, signed amounts, currency, category,
source-account labels and pending/split/group status may be returned through
these OAuth tools; raw provider IDs and credentials may not be returned.
The static assistant packet and browser Talk grants are unchanged.

Every direct tool requires the verified OAuth subject. Catalog and query
require the separately authorized `atlas.transactions.read` scope; preview
and apply require `atlas.transactions.write`. `atlas.current.read` remains
mandatory for MCP transport and does not grant Lunch Money ledger access.
The external issuer owns granting these scopes and consent.
Server-side provider credentials may be used only for those bounded calls.
Opaque principal-bound references and exact previews are ephemeral, expire in
10 minutes, and are consumed before apply. The user must see and explicitly
confirm the exact proposed change. Apply re-reads for staleness, revalidates the
category, writes once, then independently reads the provider result. An uncertain
result is unavailable as success and must never be automatically retried.
No payment, transfer, balance edit, deletion, bulk/automatic write, provider
configuration or canonical Atlas policy write is authorized by this addendum.
Pending/grouped/already-split rows fail closed. Provider read completeness is
not bank sync completeness or Atlas budget membership. Currency remains explicit.
No promise of atomicity with external clients: the provider has no conditional
write contract; process locks protect concurrent previews only in this instance.

Owner request 2026-10-02 to ask for all account balances extends the existing
read-only catalog projection to the balances already returned by the synced
and manual account GETs, including savings. The same `atlas.transactions.read`
scope and authenticated-subject gate apply. Only allowlisted account labels,
provider type/status, signed decimal balance/currency, semantic balance date
and separate sync/object timestamps leave this boundary; provider IDs, masks,
connection IDs, metadata and credentials do not. Missing values stay unavailable.
Provider dates are not replaced by request or sync time, and provider-reported
balances are not promoted to independently verified/current bank facts.
No aggregate cash/net-worth/spendable figure is calculated here. Savings,
restricted/business accounts and credit remain distinct from Forecast household
cash. Coverage is only the synced/manual accounts returned by Lunch Money,
not all institutions or the separate crypto API. No bank sync, mapping change,
canonical refresh, schema/store replacement, OAuth change or new write is granted.
