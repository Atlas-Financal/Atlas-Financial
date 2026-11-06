# Open Questions — Working Agenda

**Updated 2026-11-04.** Every unanswered question in one place, ranked by what
the answer would change. Add new questions here as accounts are reviewed; move
answered ones to the bottom with the answer recorded.

Status: `OPEN` · `ASKED` · `ANSWERED` · `BLOCKED`

This file is the sole authority for those four statuses. Other documents and
the site may hold evidence about a question. They do not close it.

---

## Tier 1 - Changes what the numbers mean

### Card purchase coverage - confirmed opening and explicit payment intent
**Status:** ANSWERED 2026-11-04 · see Answered section below.

### Savings pool setup - confirm assignments and the new baseline after funding
**Status:** OPEN · **Owner:** Dale
The convention and the current 2026-10-03 03:16:39 UTC owner-selected roles live
in `ARCHITECTURE.md`: ending 3074 for Fusion/related sports; ending 8420 for
property tax/home insurance. Role choice is answered. The owner screenshot
confirms both TD labels and suffixes. A read-only 2026-10-03 provider catalog
lookup directly links the private EMERGENCY SAVING / `cash:savings` mapping to
mask 3074, and SAVINGS-DONT TOUCH to mask 8420. Identity and role selection are
answered; no further owner identity confirmation is required. Runtime cutover
and private deployment-map installation are implementation work.

Starting confirmed goal amounts and the new baseline are deferred: Dale will
move funds himself after amounts are chosen, then confirm that baseline.
Screenshot balances are irrelevant to this setup. Unknown assignments are not
confirmed empty assignments or zero funded. Existing goal requirements remain
on commitments, yearly bills and group members.
**What the answer changes:** a later explicit confirmation supplies starting
assignments and baseline through the existing input-update / PR workflow.
Configured roles and planned goal references do not establish funded assignments.
This question does not authorize a bank action, Lunch Money write or in-app
persistent writer.

### Q1. Does the business make money?
**Status:** OPEN · **Owner:** Dale + wife + accountant
**What we know:** This question is historical coaching P&L — receipts vs coach
pay vs HELOC-funded outbound — not live Forecast income. Of the existing $23,200
of outbound e-transfers, a **CALCULATED $3,500** is traced to the Wise holiday
accounts, leaving a **CALCULATED $19,700** without a matched destination; $13,062
of the outbound stream was drawn directly from the HELOC at 4.90%. Separately,
**CALCULATED $54,213** of inbound e-transfers over 18 months (~$3,012/month) were
described in the first pass as sale proceeds. Owner-confirmed 2026-08-09 those
inbounds are coaching receipts, not resale. Owner-stated 2026-08-29: there is
**no shop / resale / inventory business**, and no other income besides known
salaries and seasonal coaching. Amanda does seasonal coaching, paid by
e-transfer; she pays coaches from that inbound; whatever is left, the household
keeps. He does not have exact historical numbers. The unmatched $19,700 **may be
coach pay; that is not written as fact**. Heavy retail purchasing remains
classified as household spending — do not reclassify it as inventory COGS. A CRA
balance was paid from the HELOC. The Deep Dive's question about where the
remaining $19,700 goes is this Q1 sub-part, not a separate household question.
**Planning (owner-stated 2026-08-29, not a historical close):** Forecast already
has the salaries. Do not add a coaching revenue line. Extra coaching leftover is
gravy when it actually arrives, not a recurring income line. Going forward he
will say coaching in/out when it happens. TENNIS INCOME stays excluded from
spendable `plan.startingCash`. Tennis BC salary remains Forecast household
income (owner-confirmed 2026-08-22). Q25 stays OPEN for the mixed remainder.
**What the answer changes:** The historical net, if evidenced. If leftover
exceeded coach pay and other evidenced coaching costs, the household kept a
surplus; if HELOC-funded outbound subsidised the activity, that is a different
historical picture. It does **not** change the live plan: coaching e-transfers
are not Forecast household income. Do not invent a margin, COGS, or a split of
the $54,213 inbound / $19,700 unmatched outbound. Planning settlement does not
close this question.
**How to answer:** Set the $54,213 of coaching receipts against evidenced coach
pay and other evidenced coaching costs, including whether the unmatched $19,700
(after the $3,500 Wise transfer) was coach pay. Do not invent a split. Do not
treat currently classified household retail as inventory. Tracked coaching
in/out would settle the historical picture; it would still not add a Forecast
income line.

### Q2. Where do the "TFR-TO C/C" transfers go?
**Status:** ANSWERED 2026-08-29 · see Answered section below.

### Q3. What is the home worth?
**Status:** OPEN · **Owner:** Dale
**What we know:** $745,674.46 of debt is secured against it on the 2026-08-19
published opening (mortgage $545,188.30 + HELOC $200,486.16). Original mortgage
$648,000 in May 2022. The 2026-08-09 review figure was $747,612.74.

On **2026-08-29** the owner set the **planning estimate at $1,200,000**. That
estimate is current planning authority for the published ESTIMATE household
net worth, home equity, and loan-to-value on the positions reporting path; it
is not an appraisal or independently verified market value. **$1,300,000 is
an optimistic high only** and is not current planning authority. Forecast does
not consume either figure.

Evidence for that planning figure, not a verified market value: JCR Design
drawings issued for permit Mar 2024 — existing main 1,381 sqft, proposed
upper addition 300 sqft, basement living 481 sqft, garage 430, crawl 717;
lot 7,205.90 sqft RS-1, SW Maple Ridge. Finished living ~2,160 sqft if
basement counts. Best same-street sold: 21238 Cutler, $1,130,000, Mar 2026
(MLS ~4 bed / 3 bath / ~2,518–2,631 sqft, lot ~7,675), listed ~$1,099,900.
Owner judgement: this house may be slightly better than that sale, which
supports ~$1.18–1.22m, not a $170k jump to $1.3m. Nearby 2026: Manor $1.15m,
220th $1.18m, Stonehouse $1.295m, Glenwood $1.35m. Maple Ridge typical 2026
SFH assessment ~$1,183,000 (−3% YoY) — a municipal typical, not a
property-level 2026 figure for this house. Next street: 21125 Cook Ave sold
$1,300,000 in 2025 (2,087 sqft) — prior year, not a 2026 same-street
comparable.

The 2026-08-21 $1,300,000 figure is dated planning evidence, not current
authority. The 2026-08-09 $1.1m–$1.4m range remains dated historical
evidence only.
**What the answer changes:** Verified market value remains unknown — that is
why Q3 stays OPEN. A planning estimate is already published on the positions
path; that ESTIMATE reporting does not close this verified-value question.
The −$730,394.82 figure is only the financial-account fragment on the
2026-08-19 opening. The 2026-08-09 review fragment was −$717,407. A
comparable the owner accepts as verified, a municipal assessment, or an
appraisal would replace the planning estimate for trust-labelled household
net worth and would determine what is possible at the May 2027 renewal,
including whether HELOC consolidation is available at all.
**How to answer:** A recent comparable sale or an appraisal. Municipal
assessment is a weaker proxy but better than nothing. The 2026-08-29
$1,200,000 planning estimate and the $1,300,000 optimistic high do not close
this question.

---

## Tier 2 — Changes the plan

### Q6. What are the two unidentified accounts?
**Status:** OPEN · **Owner:** Dale + wife
**What we know:** Account #2 sent $33,598 in across 142 transactions and received
$5,914. Account #1 received $16,945 across five large transfers and sent $2,570.
Neither is a TD account on this profile.
**What the answer changes:** $59,027 of movement. Likely connected to the
business or to the wife's accounts, which would fold them into Q1.

### Q7. Where exactly does the card's 12-month count start?
**Status:** OPEN · **Owner:** Dale (call TD)
**What we know:** Penalty rate applied from the February 2026 statement after
misses in December 2025 and January 2026. Further misses in April and July 2026.
My reading is the count restarts from the August 2026 statement, giving earliest
restoration around August 2027.
**What the answer changes:** Whether the 17.20% rate returns in 2027 or later.
Worth a five-minute call; also worth asking whether TD will reprice earlier given
the balance is small and static.

### Q8. What are the five large uncategorized HELOC advances?
**Status:** OPEN · **Owner:** Dale
**What we know:** $18,301.43 across only five transactions.
**What the answer changes:** Likely folds into Q1 or Q2, but the size warrants
identifying them individually.

---

## Tier 3 — Fills gaps, does not change direction

### Q9. What does the PayPal spending buy?
**Status:** ANSWERED 2026-08-09 · see Answered section below.

### Q13. What is the unnamed PayPal merchant?
**Status:** ANSWERED 2026-08-09 — see Answered section. There was none.

### Q14. Are Fiverr and Gumroad business costs?
**Status:** LOW PRIORITY · **Owner:** wife
Both are registered as automatic payments but neither is currently billing.
**Gumroad: a single $15.00 charge on 25 May 2024, status INACTIVE** [PAYPAL].
Fiverr does not appear in nine months of settled spend. Cancelling either would
save nothing today. Worth confirming with the wife whether they belong to the
business, but there is no cost pressure behind it.

### Q10. Are the four zero-balance investment accounts open, dormant, or closed?
**Status:** OPEN · **Owner:** Dale
TFSA, US TFSA, and two mutual-fund accounts all at $0.00. Status not stated by TD.

### Q11. What is in the WebBroker RESP?
**Status:** BLOCKED · **Owner:** Dale
Access requires accepting OTC Markets and CME/S&P exchange agreements. That is a
legal acceptance and the account holder's decision. Balance ($31,555.85) is known
from the overview; holdings, book value, and contribution room are not.

### Q12. How much of the 19% uncategorized spending is business inventory?
**Status:** OPEN · **Owner:** Dale + wife
$25,630 over 18 months could not be reliably categorized. Overlaps heavily with
Q1. Owner-stated 2026-08-29: there is **no inventory / resale / shop business
going forward**. That planning fact does not reclassify historical retail and
does not close this question without a spending reclass.

---

## Parked from the August 13 evidence pack — unanswered, not absorbed

These questions exist so the Evidence-Use Register can point `UNRESOLVED` rows
at a real incumbent. They do not answer the household facts. They do not change
`data.json`.

### Q15. When are pension withdrawals expected to start, and does that change Granite 2045 versus 2050?
**Status:** OPEN · **Owner:** Dale
**What we know:** Sun Life evidence is preserved in source intake. Live Atlas
has no retirement modeller. Fund choice depends on when withdrawals begin.
**What the answer changes:** Whether a later retirement scenario should even
consider a fund change. No change is authorised until this is answered.

### Q16. How should the Sun Life spouse/beneficiary record be corrected?
**Status:** OPEN · **Owner:** Dale
**What we know:** Source intake records a profile inconsistency (spouse field
versus beneficiary). Correction is with Sun Life, never automated.
**What the answer changes:** An owner action only. Atlas must not attempt it.

### Q18. What remains unresolved on Bell Mobility settlement state?
**Status:** OPEN · **Owner:** Dale + Amanda
**What we know (2026-08-16 statements and CSVs; $15 watch-line placement from those statements; 2026-08-18 owner closeout):**
TELUS IS CLOSED and contributes **$0** forward. It is not a telecom-cost question. Noble Disposal Services is the household garbage bill: $95.85 every
3 months on the 18th (Forecast quarterly row, firstDue 2026-09-18).

**Telecom cost (closed — not an open evidence question):**
Shaw internet is $78.40/month, dated, paid from joint chequing. Main Bell
June statement is the normal recurring baseline: $70.00 monthly services +
$25.80 device payment + $8.40 taxes ≈ **$104.20**. The $15 watch line is on
**the same Bell account** as the main phone service and is already inside
that existing Bell bill total. Atlas must not invent a second bill for that
$15 line.

A **second Bell/watch account is still active**. Owner confirmation
2026-08-16 (`AUG16-007`): do not merge it with the $15 watch line on the
main Bell account. The same Gmail handoff attached the second-account CSVs
(June 11 and July 11). Both show the same recurring cadence: BYOD Watch SA
Ultd Shr 2GB **$15.00** + GST **$0.75** + BC PST **$1.05** =
**$16.80/month**. That is the second-account recurring baseline. Do not use
that account's accumulated amount-due / arrears as the run rate. Forward
dated Bell telecom standing is therefore owner 2026-09-19 **$160/month**
from 2026-10-15, with September 2026 as the once **$283.94** due
2026-09-15. The August 2026 reconstruction **$104.20 + $16.80 =
$121.00/month** is historical only. Owner 2026-09-21: standing Bell
autopay is planned from BILLS ACCOUNT (Chequing A) as a joint-cash
withdrawal. The September once stays card-paid Travel Visa reserved
gravity. Timing of the standing recurring baseline is closed; Q18
remains the settlement-state path.

The Aug. 1 $356.62 bill is arrears + travel/roaming, not the baseline. A
valid $250 Bell Mobility payment is pending on Travel Visa dated Aug. 14;
that is settlement/payment-route evidence, not a second telecom expense.

**Still open — settlement state, not cost:** whether that pending $250 posts,
and whether any remaining main-account Bell cash still needs a joint-cash
dated row after it posts.

Do not double-count the main Bell obligation, the pending card payment, and
a second invented copy of the $15 watch line already inside the main bill.
**What the answer changes:** Whether any remaining main-account Bell cash
still needs a dated joint-cash row after the pending $250 posts. It does
not reopen Telus, the main Bell June baseline, or the second-account
recurring $16.80.

### Q20. What emergency-reserve target and Amanda retirement/RESP intent should apply?
**Status:** OPEN · **Owner:** Dale + Amanda
**What we know:** The August interviews did not capture these sufficiently.
Owner-confirmed 2026-08-16: the owner does **not** currently know what emergency
cash target the household wants. Do not invent one. Owner instruction
2026-08-24 answered the true-surplus portion: after required payments,
essential spending, incumbent liquidity protection, and required or known
future costs are protected, true surplus goes to extra debt before optional
future costs or additional discretionary cash accumulation. Among eligible
revolving cards and the HELOC, highest known interest rate wins; equal or
unavailable rates have no supplied tie-breaker and fail closed. This is recorded
as owner-stated `plan.nextDollar` policy. Emergency-reserve target and Amanda
retirement/RESP intent remain open.
**What the answer changes:** The unanswered reserve and longer-term household
policy only. The true-surplus debt ordering is no longer open.

### Q21. Should the disputed $527.80 Fusion/Burrards payment be counted once, twice, or not as a sports cost?
**Status:** OPEN · **Owner:** Dale + Amanda
**What we know:** Transaction-derived sports history includes a disputed
amount. It must not be double-counted.
**What the answer changes:** Historical sports norms only, after evidence.

### Q22. What Provincials travel details and San Diego payment/funding gaps remain unknown?
**Status:** OPEN · **Owner:** Dale + Amanda
**What we know (2026-08-16, estimates absorbed onto `plan.commitments` by
`B95`; Square One restated 2026-09-18 onto `plan.bills`; owner 2026-09-23
retired three household projects and replaced the January tournament):**
the known major future costs already have **one Plan home**. This question
does not restate their amounts, timing, or flexibility. Read the canonical
rows: `burrards-team-fees`, `warriors`, `seattle-nov`, `seattle-dec`,
`christmas-2026`, `provincials`, `san-diego`, and the dated
`fusion-household-*` instalments. Property tax stays the existing reserve.
Square One home insurance is no longer an undated commitment: it is the
dated yearly card-paid `plan.bills` row `square-one` (10 February,
`firstDue` 2027-02-10). Do not copy those values here.

Owner 2026-09-23 removed these from active future planning. They are not
hidden rows and they do not encumber Forecast: `downstairs-couch`,
`exterior-painting`, `vehicle-maintenance`. `indio-tournament` is retired
and replaced by `san-diego` (San Diego, California). Its confirmed trip
window, points-covered flights and hotel checkout/payment date are recorded
on that canonical row; do not ask for those confirmed facts again. Its
existing modeled cash date follows the incumbent clear-month 15th rule
and stays pending separate all-in payment evidence. January 15 salary
cannot establish January 10 hotel checkout funding. Do not restore Indio
beside it.

There are no other specifically known tournaments. Tacoma is not on the
current known list.

Still unanswered:
- Provincials location and travel details. The owner-approved funding-ready
  planning target is recorded on the existing `provincials` row, alongside
  its planning amount and provenance. It does not establish an issuer
  payment deadline, registration invoice, payment or actual saving.
- San Diego hotel amount, remaining all-in trip costs and other payment
  deadlines, and demonstrated cash available by the confirmed checkout.
  The hotel checkout/payment date alone does not establish one payment
  deadline for the full planning envelope or prove checkout funding.

Closed by the 2026-09-23 instruction:
- exact due dates for downstairs couch, exterior painting, and vehicle
  maintenance — those are no longer active commitments
- a point amount for Indio — Indio is not an active commitment

ON TRACK / AT RISK / FUNDING GAP waits on `B94` and applies to these
**major future plans**, not to individual transactions or budget
categories. Ordinary spending matters through its aggregate effect on the
household's ability to fund those plans.
**What the answer changes:** A dated cash event, or collapsing a range to
one amount, only after evidence exists. Do not fabricate dates or midpoints.
A later estimate change is an edit to the existing `plan.commitments` row
(`B95`), not a new question and not a new backlog item.

### Q25. How much of Amanda’s TENNIS INCOME balance is genuinely household-available after coaching, business, and pass-through obligations?
**Status:** OPEN · **Owner:** Dale + Amanda
**What we know:** The account (id `amanda-debt-payments`, display name
TENNIS INCOME, previously labelled DEBT&PAYMENTS) is already excluded from
spendable `plan.startingCash`. Coaching/business receipts land there;
coaches/business/pass-through amounts are paid first. Owner-confirmed
2026-08-22: the two fixed Tennis BC salary deposits ($2,168.85 on the 15th
and $2,387.99 on month-end) are Forecast household income. Owner-clarified
2026-08-31: they first land in this TENNIS INCOME account and are not
spendable there; household-visible posting proof is the later transfer into
BILLS ACCOUNT. That path is not what this question is for. Q25 is only
the uncertain coaching/business remainder of the mixed operating-account
balance. Owner-stated 2026-08-29: extra coaching leftover is gravy when it
actually arrives, not a budgeted inflow, and does not make this mixed remainder
spendable starting cash. The Aug. 14 payday session observed $798.37 in that
account. A fresh balance is not automatically spendable starting cash. Do not
estimate how much of the current remainder is household-available.
**What the answer changes:** How much, if any, of that mixed-account
remainder can enter household available cash after a refresh. B91 must
preserve held/pass-through semantics rather than guessing.

---

## Queued for the next round of accounts

- Other credit cards — balances, rates, limits, minimums, due dates, statement history
- The wife's business — accounts, revenue, cost of goods, tax status, registration
- Any additional loans, financing, or institutions not yet named

---

## Answered

### Card purchase coverage - confirmed opening and explicit payment intent — ANSWERED 2026-11-04
**Answer (Dale, 2026-11-04, #787 comment 6641053911):** "the same amount or
more money need to go onto the card than leaves." No purchase-by-purchase
confirmation. Coverage is aggregate, per card, per pay period: household
payments onto a card at least equal to that period's new native-CAD purchases
(net of refunds and reversals) cover all of them, and the excess pays existing
card debt. A shortfall stays uncovered, carries forward and stays protected in
Bills until later payments cover it. **Amended (owner, relayed by the lead
on #787):** the required inflow per card and period is the minimum due in the
period plus net new purchases; payments apply to the minimum occurrence first,
then purchases, then existing debt. A generic "TFR-TO C/C" that cannot be tied
to a specific card stays To confirm. The Amazon MBNA and Triangle Mastercard
are manual, pay-down-only cards with no feed and no new purchases (Dale,
2026-11-04): their required inflow is the minimum only, and a payment with
that card's identity settles the minimum first, then existing debt. The opening is the 2026-11-06 payday,
confirmed empty; card balances before it are existing card debt (the lead's
recommendation; Dale did not object, and a different boundary he names
replaces it). Payments count by posted direction and account identity, not
intent. Item card charges that Savings pays are the separate Savings-funding
extension (#843 finding 11). Pending purchases stay pending; a foreign
currency, an unmapped account, or a payment whose direction or account is
unknown stays unknown and withholds. Nothing is inferred from amount alone.
**Rule home:** `docs/proof/CARD_PURCHASE_COVERAGE.md` (mechanism) and
`plan.cardPurchaseCoverage` in `data.json` (the opening, with no amounts).
**Trust:** source transactions verified; period sums and shortfall calculated;
forward protection estimated.
**Superseded record (kept for history):** the earlier evidence asked for a
purchase-level opening, Bills debit/card credit pairs with named purchase
allocations, and explicit refund/reversal links. Dale's 2026-10-05 purple
marker choice and the pay-period starting points still stand.

### Q2. Where do the "TFR-TO C/C" transfers go? — ANSWERED 2026-08-29
**Status:** ANSWERED · **Owner:** Dale
**Answer:** Owner evidence 2026-08-29: Dale sent an EasyWeb Credit Cards
screenshot. **Only three TD credit cards exist.** Do not invent a fourth.

| EasyWeb label | Last four | Atlas identity | Screenshot balance 2026-08-29 |
|---|---|---|---|
| PERSONAL CREDIT CARD | …5770 | `tdcc` / Emerald personal ••70 | $1,769.87 |
| TD CASH BACK VISA | …0726 | `cashback` ••26 | $5,040.01 |
| TRAVEL VISA | …0870 | `travelvisa` ••70 | $1,216.52 |

Those screenshot balances are **dated EasyWeb observations**, not a
canonical opening rewrite. They do not replace the 2026-08-19 `data.json`
cents. Forecast remains the only planner.

What this answers:

1. **TFR-TO C/C is payments to the known cards**, not a missing fourth TD
   Visa. The original worry — a significant TD card absent from the debt
   ranking because the personal/Emerald balance barely moved and showed no
   purchases — is closed. Emerald/personal is the separate TD credit-card
   product whose balance barely moved in the original Q2 window.
2. **“Two TD Visas”** means Cash Back + Travel. Emerald/personal is the
   third TD credit-card product, not a Visa-named fourth card and not
   missing.
3. **Individual June HELOC TFR-TO C/C lines still do not have per-card
   destinations.** Do not fabricate those. The 12-month payment-matching
   table in `docs/ACCOUNT_FACTS.md` remains dated analytical evidence that
   captured cards received more than labelled TFR-TO C/C sent; it is not
   a per-line allocation of June HELOC transfers.

MBNA/Amazon is a known non-TD card (Q4 ANSWERED). It is not a fourth TD Visa.

### Q26. What are the current pending amounts on Cash Back Visa and Travel Visa when exact action is needed? — ANSWERED 2026-08-18
**Status:** ANSWERED · **Owner:** Dale
**Answer:** Travel Visa posted $862.68 and pending Bell Mobility $250.00
are the 2026-08-16 canonical opening. That pair remains a dated canonical
write for 16 August.

The remaining Cash Back evidence question is answered by the PR #106
completed unbounded Lunch Money `is_pending=true` census: current Cash
Back pending was proven **0**. Cash Back is a normal live Lunch Money
revolving-credit account, not an owner-maintained monthly statement
account. That census is evidence only.

The owner-approved 2026-08-19 opening is the owner-authorized pending
write: Cash Back `pendingUnknown` is false and pending is **$0.00**;
Travel Visa posted **$1,205.33** and pending **$0.00**. The 16 August
UNKNOWN-unwritten constraint is closed by that dated opening. Atlas must
not treat a later unknown pending as $0.

A later live pending CHANGE (including Travel Visa 250 vs observed
342.65) is a cutover pending-state question, not a reopening of this
evidence answer.

### Q19. What is the remaining August HELOC cash impact given the unproven Aug. 1 PAD? — ANSWERED 2026-08-18
**Status:** ANSWERED · **Owner:** Dale
**Answer:** Owner evidence 2026-08-18, read against the Dec 2025–Jul 2026
HELOC statement series already preserved in the repository.

1. **Interest posting.** $814.18 posted 31 July 2026. It increases the HELOC
   balance. Forecast treats it as a non-cash capitalisation (`nonCash` /
   `cashPayment: 0`). Interest is not free and does not disappear.
2. **Minimum-payment obligation.** The statement minimum is $814.18 due
   21 August 2026. The current screen continues to display that minimum.
3. **Payment satisfaction.** The owner made a $1,100 payment into the HELOC
   on 14 August, already inside the 2026-08-16 canonical opening.
   Demonstrated HELOC history shows that a manual payment at least equal to
   the minimum, made before the due date, satisfies that minimum rather than
   causing TD to collect the same minimum again as a second cash withdrawal
   (February $751.46 collected in full; May $810.09 collected as residual
   $800 + $10.09). $1,100 is larger than $814.18.
4. **Remaining August cash requirement.** $0 additional HELOC minimum should
   be reserved after the 14 August payment. Atlas must not forecast another
   $814.18 August joint-cash outflow.

The displayed activity after the 31 July interest posting does not show an
Aug. 1 HELOC PAD/payment. This answer does **not** state that the Aug. 1 PAD
occurred. If later direct transaction evidence shows TD nevertheless collected
another August minimum after 14 August, that is new evidence and this
conclusion may be reopened. Do not invent such a transaction now.

### Q4. What are the balances and rates on the remaining non-TD debts? — ANSWERED 2026-08-16
**Status:** ANSWERED · **Owner:** Dale + Amanda
**Answer:** Triangle, MBNA, Affirm, and Flexiti are no longer unknown. Affirm
and Flexiti are different accounts and must not be combined.

Triangle (current canonical Forecast opening is 2026-08-19): posted
**$13,495.32**, pending **$0.00**, limit $13,500. Available credit is
Forecast-derived (not cash). The 2026-08-16 screenshot opening was posted
**$13,197.00**, pending **$15.62**. The retired 9 August opening was posted
**$13,497.00**. Purchase rate remains 21.99% / cash 22.99% from the earlier
disclosure. Displayed minimum $0.00; displayed due date Aug. 7 2026; future
minimums remain estimated.

MBNA (current canonical opening is 2026-08-19): posted **$7,875.99**, pending
$0.00, limit $8,000. The 16 August opening was posted **$8,003.61**, pending
$0.00. The retired 9 August opening was posted **$7,855.12** + pending
**$82.05**. Statement remains authority for min/due/APR: statement balance
$7,855.12, minimum **$158.27**, due **2026-08-31**, purchase APR **21.74%**,
cash advance / BT APR **22.99%**, statement interest $148.27. Do not round a
dated opening back to the statement amount.

Flexiti is closed (owner-confirmed 2026-08-31): nothing remaining to pay. Affirm
is not Flexiti and is not closed. Owner 2026-08-23, reconfirmed 2026-08-31: one
final **$32.53 payment is due 2026-09-21**, with no recurrence after it. Forecast
schedules that cash obligation once. The current contractual balance and rate
remain unverified and are not invented from the payment amount.

### Q4b. Was the Triangle payment due 7 August actually made? — ANSWERED 2026-08-16
**Status:** ANSWERED · **Owner:** Dale
**Answer:** A **$300 payment posted 2026-08-10** (TD BANKLINE/TELELIGNE TD).
That closes the stale claim that no payment appears to have posted. The
payment posted after the displayed Aug. 7 due date. On-time status and any
default-rate consequences are **not** proven from the screenshot alone.

### Q5. Why did the wife's monthly transfer stop after May 2026? — ANSWERED 2026-08-16
**Status:** ANSWERED · **Owner:** Dale + Amanda
**Answer:** Amanda is no longer receiving the garage/lab income that funded
that historical ~$1,000–$1,100 monthly transfer. This is not missing
household income. The income source ended. Atlas does not forecast that old
stream.

### Q17. What is currently due on BC Hydro, as distinct from the account balance, and has the past-due amount been paid? — ANSWERED 2026-08-16
**Status:** ANSWERED · **Owner:** Dale + Amanda
**Answer:** Owner-confirmed 2026-08-16: the old BC Hydro amount previously
questioned as outstanding has been **SETTLED**. It is not a future
obligation. The known future Sep. 1 Hydro obligation of **$237.45**
(`hydro-due-sep1`) remains a current valid bill. Owner 2026-08-30: future
Hydro is planned from BILLS ACCOUNT (Chequing A) and reduces joint cash.
Historical Lunch Money postings from TENNIS INCOME are not rewritten.
Settlement of the old amount does not cancel that future bill. The account
balance is still not scheduled as a cash event.

Owner 2026-09-09: BC Hydro annual-adjustment notice confirms the equal
monthly payments plan. The current monthly was $234; **on the next bill
the monthly amount becomes $199.00**. Atlas encodes that from the next
bill forward as `hydro-equal-payment` ($199 monthly, estimated firstDue
2026-10-01) on BILLS ACCOUNT. The $199 amount is confirmed; the payment
day is not. The same notice shows a **−$53.08 credit still on the Hydro
account**. Owner MyHydro screenshot this turn corroborates current
balance **$53.08 Credit** and a 9 September 2026 bill amount of
**−$53.08**. The **5 September – 6 October 2026** billing period on that
screen is a period window only, not payment/due-date evidence. Forecast
nets the next equal-payment cash hit to **$145.92**
($199 − $53.08); later months are full $199. That credit is not
+$53.08 joint cash on 9 September. The 1 September $237.45
`hydro-due-sep1` once due remains. This does not reopen the arrears
question. Next annual adjustment is September 2027; that later amount
is unknown until the notice.

**Owner 2026-11-03 (bill document; due-day evidence recorded):** the
2026-10-08 BC Hydro bill shows the equal-payment plan amount **unchanged at
$199.00**. That bill's total due, **$145.92**, was the $199.00 current
charges less the $53.08 credit balance forward, due by **2026-10-30**, and
was paid on 2026-11-03 from chequing (after the due date). `hydro-equal-payment`
therefore keeps $199.00 monthly with the existing first-occurrence credit net
(which already yields $145.92 for October; no amountSchedule term, since that
would net the credit twice), and its due day moves from the 1st to the **30th**
(clamped in short months) from the October 2026 occurrence. The day stays
**estimated**: one bill evidences it and BC Hydro's due date is about 22 days
after the billing date, so it can vary by a day or two. The payment is left to
transaction matching, not hand-marked. Reopen if a later bill shows a different
due day.

### Q23. How do the three live-plan $500 Fusion instalments relate to the travel-team or season fee, now that camp and tryouts are paid? — ANSWERED 2026-08-16
**Status:** ANSWERED · **Owner:** Dale + Amanda
**Answer:** There are currently **NO pending Fusion instalments**. The three
live-plan $500 rows were stale and have been removed from `plan.commitments`.
Camp and tryouts remain settled as of 2026-08-14. Upcoming Fusion season is
a planning estimate only: approximately 4 × ~$500, probably starting late
September 2026. Exact total, dates, and instalment count remain unknown and
are **not** confirmed invoices.

### Q24. Is "School & clubs" essential or discretionary for the household operating plan? — ANSWERED 2026-08-16
**Status:** ANSWERED · **Owner:** Dale + Amanda
**Answer:** School & clubs is **ESSENTIAL** for the household operating
plan. `plan.budget.categories` id `school` now matches
`docs/merchant-library.csv` / `public/periods.json`. The nine Aug. 10 owner
`plannedMonthly` targets are unchanged.

### Q0. Where are the two named owner budget workbooks? — ANSWERED 2026-08-16
**Status:** ANSWERED · **Owner:** Dale + Amanda
**Answer:** The original question was “where is the household budget that was built with the owner?” Both named workbooks exist. Amanda emailed `HOME BUDGET.xlsx` and
`monthly_budget_tracker_template.xlsx` to Dale on 2026-08-09. They are
classified in
[`docs/source_intake/HOUSEHOLD_BUDGET_WORKBOOKS_2026-08-16.md`](source_intake/HOUSEHOLD_BUDGET_WORKBOOKS_2026-08-16.md).
The binaries stay out of git.

They do **not** replace the nine owner-stated Aug. 10 targets in `data.json`.
`HOME BUDGET.xlsx` is historical per-paycheque planning (groceries ~$1,200/month
and gas ~$400/month conflict with the later $1,800 and $1,300). The tracker's
`My Recommendation` section is advisory, derived from April/May actuals, and is
not owner policy. Personal $600 and Subscriptions $300 match on amount only;
the Personal → Shopping mapping is still unconfirmed. Sinking-fund planning in
the older workbook is not a current approved target.

Q0 was "where are the workbooks / absorb them." That is done. Remaining items
are ordinary policy questions already recorded on the budget block: completeness
of the nine lines, current sinking-fund amounts, and the Personal mapping.
They are not a continuation of "find the missing files."

### Q9. What does the PayPal spending buy? — ANSWERED 2026-08-09
351 transactions reviewed, July 2025 – March 2026. **$5,725.63 outgoing over nine
months, about $636/month.** Roughly **73% is entertainment**: gaming $1,588.80,
Apple Services $1,138.72, food delivery $956.48, streaming $521.76. At least 16
active automatic payments.

Three useful negatives, each of which closes off a hypothesis:
- **No business revenue passes through PayPal.** The 160 "incoming" entries are
  bank-funding pulls from Chequing A, not sales.
- **No person-to-person transfers at all**, so PayPal is not the channel behind
  the unexplained e-transfers (Q2, Q6).
- **No hidden asset or debt** — balance $0.00, Pay-in-4 plans complete.

**Corrected 2026-08-09.** The first pass reported ~$636/month and a $623.52
"unnamed merchant". Both were wrong — the total double-counted PayPal's
*General Currency Conversion* rows (the CAD leg of foreign-currency purchases
already counted under their merchant names) plus two fully-refunded withdrawals.
Corrected figure: **$4,168.89 settled over nine months, ~$463/month**,
cross-checked against $4,262.43 of bank funding pulls (~$474/month).

### Q13. What is the unnamed PayPal merchant? — ANSWERED 2026-08-09
**There was no unnamed merchant.** The ten blank-name rows were eight currency-
conversion legs and two refunded withdrawals. The conversion legs pair exactly
with foreign-currency music-software purchases: amalgam audio €35.00 ×2 →
−$59.05 ×2, amalgam audio €30.00 → −$50.46, Boutique Tones US$60.00 → −$86.20,
IK Multimedia €49.99 → −$84.23. Verified against the December 2025 activity page.
