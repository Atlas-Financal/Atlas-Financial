# Card purchase coverage: local candidate and independent oracle

## Current contract: the owner's aggregate rule (2026-11-04)

This section is the home of the card-coverage rule. The sections after it
record the earlier purchase-level intent contract, which the rule replaces
for the production plan; they remain history and describe the explicit-record
mode that only a policy without `rule` still reads.

**Owner rule** (Dale, 2026-11-04, #787 comment 6641053911): "the same amount
or more money need to go onto the card than leaves." `plan.cardPurchaseCoverage`
names `rule: "aggregate-per-card-per-pay-period"` and a confirmed empty CAD
Bills opening on the 2026-11-06 payday. It holds no amounts and no records.

**Authority.** `Forecast.reconcileCardPurchases` (published as
`visaPaymentReconciliation`) stays the single card-liability owner. Under the
rule it derives coverage from posted rows; it reads no intent record, and a
policy that names the rule and also carries payment, refund or reversal
records withholds (`coverage-records-invalid`). No second ledger exists.

**Mechanism, per card, per pay period** (Forecast's `spendingCycle` periods):

1. Purchases are the card's posted native-CAD charges that the incumbent
   classifier already treats as card purchases (household spending,
   represented bills and item-attributed charges). Pending purchases stay
   pending: they are reserved in full and cannot be covered until posted.
2. Refunds are posted card credits without payment identity whose same row as
   a charge would be household spending. Any other card credit withholds.
3. A payment is a posted pair: a card-side payment credit on the mapped card
   and a household cash (chequing) payment debit of the same cents within
   three calendar days, each the other's only candidate. The card leg fixes
   the card and the period. A generic Bills "TFR-TO C/C" debit is tied to a
   specific card only by that unique card-side leg; without one it stays
   unconfirmed and withholds. A payment reversal is the mirror pair and reduces
   that period's payments. A pending leg counts only once posted. A cash leg
   that already represents a scheduled occurrence (a card minimum or a
   card-paid bill, by `representedActuals`) settles that occurrence first;
   only the rest of the pair covers purchases, so one cash event never relieves
   both a scheduled requirement and the household hold. A represented amount
   that is unknown or larger than the pair withholds.
4. **Minimum first** (owner amendment relayed by the lead on #787, amending
   6641053911): the required inflow per card and period is the card's minimum
   occurrence due in the period (its `effect: payment` obligation) plus net
   new purchases. Each payment, in date order, applies first to that minimum,
   then to purchases, then to existing debt. Below the minimum, the minimum is
   `partial` or `to-confirm`; covering the minimum but not the purchases
   leaves the purchase shortfall protected.
5. The period's refunds and then payments cover the oldest uncovered amount
   first (a confirmed opening carry, then earlier shortfalls, then this
   period's purchases by date). That order only labels which purchase markers
   clear; it never changes a card's total. Excess in a period pays existing
   card debt (`otherPurpose: prior-debt`) and never pre-pays a later period.
   A shortfall carries forward and stays protected in Bills.
6. Card activity dated before the opening is existing card debt, which
   `Forecast.utilisation` tracks. An opening still ahead of the as-of protects
   nothing yet. The opening must be a pay-period start.

**Withholds** (status `unavailable`, no reserve, no available-cash claim): an
unconfirmed opening; an opening off a payday; a foreign or missing currency or
amount; an unmapped or ambiguous account; unknown pending status; a card
payment credit with no household cash leg (`coverage-payment-source-unconfirmed`);
a cash payment debit with no card leg (`coverage-payment-destination-unconfirmed`);
more than one candidate pairing (`coverage-payment-pair-ambiguous`); a card
credit paid from Savings (`coverage-savings-funded-payment-unmodeled`, the
separate Savings-funding extension of #843 finding 11, so it is never counted
as household coverage); a payment reversal larger than the period's payments.
Nothing is inferred from amount alone: equal cents are necessary, never
sufficient.

**Pay-down-only cards** (owner fact, Dale 2026-11-04, via the lead):
`payDownOnly: ["mbna", "triangle"]` names the manual Lunch Money cards with no
transaction feed and no new purchases. Their required inflow is the minimum
only. A posted household chequing debit that carries that card's existing
payee identity (MBNA, CAN TIRE MC; the observer stamps it as
`cardPaymentDestination`) pays the minimum first and then existing debt. A
generic "TFR-TO C/C" names no card and stays unconfirmed. Any card-side row on
such a card contradicts the owner fact and withholds. Their manual balances
keep their own dated as-of; the observer already refuses a stale one as
current (`stale-not-current`), and a balance change is never read as a
purchase.

**Minimum fact, an adapter point.** The publication's `minimumCoverage` rows
(`obligationId`, `scheduledDate`, `due`, `covered`, `status`
`covered-by-payment` / `partial` / `to-confirm`, `paymentIds`) state which
payment covered which minimum. The card ledger never sets a bill row's status:
the bill authority (`billPaymentState` / `matchBillPayments`, #841) consumes
this fact. Until it does, the minimum's Bills row keeps its own status, so a
covered minimum is still deducted from Bills: conservative by that amount,
never optimistic. The conservation test names this interim term.

**Downstream.** The reconciler hands its derived pair allocations to
`billsAccountPeriodBalance`, which counts only a Bills leg as Bills funding of
the household hold, exactly as an explicit record did. The PA-4
matching-only estimate reads explicit records only, so an aggregate-rule hold
stays a hard hold there.

**Trust.** Source transactions are verified; the period sums and shortfall are
calculated (each published `periods` row is tagged `calculated`); the forward
protection is estimated.

**Proof.** `test/test-card-coverage-aggregate-rule.js` (invented numbers, each
expected figure written from the rule): equal, above and below payments with a
carry, a refund, a pending purchase and pending payment, unknown direction,
unequal cents, ambiguity, a Savings-funded payment, an unexplained credit,
foreign currency, two cards, the period boundary, the opening, and Bills
period-end conservation (500 - 25 - 150 = 325 plus any excess repaid in every
state). `test/test-r1-ready-path-card-protection.js` adds aggregate twins
that reach the same hand ledger for every later Budget opening, sweep and
Savings close, and the #843 item term, with no intent record.


This is a synthetic-only candidate, not production household facts or a
deployment claim. Parent authorized replacing #491's inferred split with one
evidence-qualified ledger and immediate cash protection. No transaction,
account, canonical amount, baseline or credential was changed.

## State and coordination boundary

The takeover began at #491 head 3f805ee19467f0bbb5dae84b2314170e4e738fec.
Both that history and the later remote head
83eda4aa7b3ba561f56e12ab472235980c19f1d9 are preserved in the local candidate.
Checkpoint 72024e5715745908937d307cff43ae0e8245f4ad implemented the explicit
ledger; merge a1a5a77 reconciled the changed remote. Local merge
c7276c5edc5cb046b1fa471bd52db48e676aee7a incorporated main
feb40019a931fe93ab18fccf6290886920c41d7a, including #492 native-unit guards.
Subsequent consumer/fixture repairs are recorded in the next commit. The
exact tested head and results belong in the evidence manifest and PR record;
this document cannot embed its own future commit SHA.

Through the local B1 checkpoint, parent held publication while coordinating
the changed remote. Nothing was pushed at those checkpoints and no competing
PR was created. Parent owns independent Systems review and any merge.

## Independent supplied-dollar oracle

Early posted card-bill identity evidence can leave its future scheduled cash
reservation in the walk. Forecast credits only that duplicate hold against the
same uniquely linked, posted purchase's remaining coverage. Full purchase
coverage, the planned Budget deduction and explicit payment allocations remain
unchanged. Pending matching bills retain the existing pending exclusion and
never gain settlement from this credit. The independent invented regression is
`test/test-posted-card-bill-protection.js`: 500 cash minus one 73.21 purchase is
426.79 across current and next-period early posting; an unrelated 19.37 purchase
leaves 407.42. Currency, account, amount, identity, ambiguity and unavailable
coverage controls withhold the credit.

The confirmed-backfill lifecycle oracle additionally follows the same invented
purchase through pending, posted, partial and full backfill, in both current and
next-period schedules. Observed Bills cash and card debt already include each
posted transfer once. A current dated cash opening allows the posted purchase
to replace the full duplicate schedule hold, while coverage retains only the
actual remaining purchase. Older, missing or future cash-opening dates retain
the paid portion's cash reservation. Payment intent and mapped posted movement
qualification remain owned by the existing reconciliation; this credit creates
no receipt or allocation. `test/test-card-bill-protection-lifecycle.js` also
covers the following monthly occurrence, repeated refresh, unknown payment
evidence and pending purchases that must never gain paid settlement.

The fixture supplies Bills 500, prior card debt 400, groceries allowance 150,
scheduled minimum 25 and a confirmed empty coverage opening.

| Snapshot | Bills | Card debt | Groceries spent once | Uncovered | Available after minimum, remaining groceries and coverage |
|---|---:|---:|---:|---:|---:|
| Before | 500 | 400 | 0 | 0 | 500 - 25 - 150 = 325 |
| Purchase 30 | 500 | 430 | 30 | 30 | 500 - 25 - 120 - 30 = 325 |
| Confirmed backfill 10 | 490 | 420 | 30 | 20 | 490 - 25 - 120 - 20 = 325 |
| Confirmed 25 split: 20 backfill, 5 prior debt | 465 | 395 | 30 | 0 | 465 - 25 - 120 = 320 |

The $20/$5 split is an explicitly supplied invented intent record. Amount,
date and payment payee cannot establish it. Without that intent or its unique
posted Bills debit/card credit, precise funding is unavailable and no split
is published. The scheduled minimum stays reserved. Existing exact
represented-events confirmation can separately prove issuer settlement.

Both original #491 and the changed 83eda4a remote label an unconfirmed $10
as backfill and drop the remaining $20 before labeling the next $25 as card
payment. Independent red controls are ../pr491-intent-red.log and
../pr491-83-intent-red.log. The latter exercises the exact changed remote
using invented CAD rows, with no Bills pair or intent supplied.

## Proposed input contract, exercised only in fixtures

Forecast.visaPaymentReconciliation retains its historical API name and owns
one ledger for mapped revolving cards. The observer supplies sanitized,
account-bound coverage references, native currency and provider-directed
replacement flags. References establish identity, never intent.

plan.cardPurchaseCoverage contains a confirmed CAD Bills opening with a
cutover date and explicit carried purchases (ref, accountId, date, amount,
covered). An empty opening is still an owner confirmation, not an inference
from a bounded fetch or a debt balance. A complete posted/pending observation
must cover that cutover through the financial as-of; the existing bounded
history cap is retained.

payments name unique debitRef and creditRef, confirmed purchase allocations
and an explicit otherAmount/otherPurpose. Allocations and the remainder must
conserve the whole posted pair in exact cents. Other purpose is prior-debt,
required-payment or other; none automatically settles the scheduled minimum.
refunds explicitly link a posted credit to its purchase. reversals name the
original payment and unique reversed card/Bills legs, and may reverse only
previously allocated amounts. Used identities cannot be credited twice.

No production opening or allocation has been installed. Needed owner facts
are recorded in docs/01_OPEN_QUESTIONS.md. Missing opening, currency, pairing,
identity or intent remains unknown. Foreign/missing native units and mixed
replacement evidence do not publish raw values as CAD spend or coverage;
to_base is not conversion authority.

## Financial and publication boundary

Purchases retain existing category classification and count once. A unique
pending revolving match of a still-due card-paid bill is reserved as that
bill once; coverage does not also hold the pending authorization as
uncovered spend. Coverage
adds protection to the existing simulation cash floor; it does not subtract
cash again, inject money, add a scheduled expense or create debt. Actual Bills
cash and card balances remain observer facts. Fully covered rows leave the
active list and keep audit detail. Partial uncovered amounts carry until an
explicit coverage allocation or linked refund changes them.

Unknown coverage withholds precise capacity, funding, weekly permission and
extra-debt instructions. Known bill facts, named costs and observed cash are
retained. Forecast alone withholds usable money; OperatingAnswer and
RefreshTrust copy that publication. Known spending-category facts remain
available. Calendar extra-debt rows and their existing printer preserve
unavailable rather than displaying an invented zero. With no card
evidence/configuration, the incumbent publication is
unchanged; its independent immutable savings before/after proof passes.

BillDetail prints this ledger only. public/plan.js passes the active coverage
publication into the existing #491 renderer. No original-plan/actual totals
or goal-fulfillment selector is implemented here. Expected UI-follow-up
overlap is calendarPeriodWaterfalls, paydayAllocation and selected-period
funding/withheld state; parent owns sequencing.

## Verification and remaining gates

Independent synthetic tests cover observed cash/debt/category reconciliation,
partial and combined allocations, refund/reversal conservation, pending
purchases and legs, missing intent/pair/opening/identity/date, native units,
privacy and separate issuer minimum evidence. The annual-card-fee financial
assertion remains unchanged. Legacy synthetic observations declare CAD units
where their fixtures intend CAD; declarations do not supply payment intent.
Old funding expectations were adjusted only where they released an uncovered
purchase hold or claimed usable cash without confirmation. No real financial
fixture, amount or account has been edited.

The full run frozen at c7276c5 passed 272/287 suites. Fifteen failures were
triaged into consumer/fixture mismatches, the omitted authority printer name,
and four Windows execution constraints. Focused fixes preserve known
category/bill facts while withholding precise permission. Windows checks use
process-only Git Bash and core.autocrlf=false; CurrentUser encryption checks
need unsandboxed execution. The reference snapshot harness now uses a Windows
directory junction rather than a privileged file symlink, keeping the same
financial oracle. No suites are skipped or assertions weakened to pass the
platform. A fresh exact-head full run is required after these changes.

Authenticated headless Edge exercised the actual Budget consumer on c7276c5
with fully synthetic server data. It printed the $80 purchase hold from the
Forecast ledger. Local evidence: ../491-browser-proof.json,
../491-browser-coverage.png and ../491-browser-dom.txt. Repeat on the frozen
final candidate; earlier evidence does not certify a later head.

Production remains unconfirmed until the household supplies the opening and
explicit links recorded in docs/01_OPEN_QUESTIONS.md. Independent Systems
review and parent publication coordination remain separate gates. No claim
of deployment, production reconciliation or lender non-payment is made.

## Local Systems review B1 repair

Independent review blocked 1036127 because the active funding legend/chart
showed only $95 of components against $175 needed after an invented $80
purchase. The partial $20 backfill omitted the remaining $60; full coverage
resolved the discrepancy. Capacity arithmetic was already correct.

The printer now copies Forecast's cardPurchaseCoverageReserve into the Today
legend/chart and detailed from-today evidence. Copy names this cash protection
separately from the minimum and category. No new page money calculation is
introduced. The existing chart percentage calculation uses the published hold.

The supplied-cent oracle checks before/purchase/partial/full at 1440px and
390px: required cash 175/175/155/95, card hold 0/80/60/0, cash
500/500/480/420, and capacity 325 throughout. Minimum 25 and original
groceries 150 remain separate; spending is 80 once after purchase. The standard
card-coverage suite executes the real printer and totals its printed cents
independently. test/browser-card-purchase-coverage.js exercises authenticated
Budget click paths at both widths and records visible parts, chart geometry,
copy, no overflow/runtime errors and screenshots. Run it with CHROME_PATH
and optional ATLAS_CARD_COVERAGE_EVIDENCE_DIR. Exact-head browser results and
review belong in their evidence manifests; the earlier blocking verdict does
not transfer to this repair. Publication was held at that local checkpoint.

## Authorized integration after publication hold

Dale explicitly resumed work on 2026-10-04 at 14:33 UTC. Integration preserves
remote PR head d3cb2ce3935ae842a19e04616421872530b17deb and current main
9c4601bafe82297fd7984dd81135452c19261b9c as ancestors, retaining the reviewed
local ledger and B1 repair. The rebase's legitimate #492 changes were already
present; its inferred previous-payment split and observer-side split are
superseded by the sole evidence-qualified ledger. No remote commit is deleted.

Current main's original-plan/actual-progress, exact-period goal evidence and
newer native Budget UI are preserved. Their scope and unconfirmed fulfillment
remain distinct from available cash. A fresh independent current-main fixture
reproduces $405 capacity without purchase coverage against the supplied-dollar
$325 oracle; an $80 purchase reduced remaining groceries to $70 without moving
$500 Bills cash, and the $25 minimum remains separate.

Fourteen focused suites and eight authenticated desktop/mobile states passed
on the integration before this documentation update. Both revisions generated
their own canonical snapshots; all 568 figures matched current main. Exact
final-head tests, browser manifests, full CI and review status belong in the
PR/evidence record. The earlier local Systems PASS applies only to 143ea01,
not this newer integration. Publication is authorized only after fresh remote
head checks and by normal fast-forward push; concurrent movement stops it.
No production opening/intent or provider write is authorized by this repair.
