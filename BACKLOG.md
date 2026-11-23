# Backlog

**Confirmed savings inventory - 2026-10-02 owner instruction - IN PROGRESS.**
One outcome: show confirmed goal intent backed by observed cash in two explicit
reserve pools, with unallocated cash, pool deficits and honest unknown/stale/
pending states on Budget and Plan Spend. Authority is recorded in
`ARCHITECTURE.md`; proof is in `docs/proof/SAVINGS_EARMARKS.md` and the synthetic
savings earmark suites. The 2026-10-03 owner role selection is recorded in
`ARCHITECTURE.md`, superseded by the 03:16:39 UTC selection: ending 3074 is for
Fusion and related sports; ending 8420 is for property tax and home insurance,
with explicit legacy staging reconciliation in the configuration cutover. A `budget-reserve`
earmark reference consumes the incumbent property-tax reserve without another
obligation or cash event; synthetic unit and authenticated integration proof
cover this path. Read-only provider masks directly prove the 3074 and 8420
identity links. Configuration activates both purpose roles with no funding
history; deployment must install the prepared private mapping changes. Starting
assignments and the new baseline remain unset pending the owner's later funding
confirmation. Incremental savings instructions stay withheld when
configured until allocator seeding and corresponding reserve-backed payment
flows are integrated and independently proved. This PR does not implement that
integration, change fuel/currency/classification policy, write to a provider or
merge itself. Closure requires independent Systems Review and exact-head checks.

**Work that can be done.** Questions only the household can answer live in
`docs/01_OPEN_QUESTIONS.md` — keep the two apart. If an item needs a human to
*know* something, it is a question. If it needs someone to *do* something, it
belongs here.

Status: `READY` — nothing blocking · `BLOCKED` — waiting on the household ·
`QUEUED` — waiting on earlier work · `IN PROGRESS` — first slice landed, item
not closed

Last reviewed **2026-08-17**. Phase: **analysis** — capture is essentially done.
Lunch Money is the normal operational update feed; file capture is fallback.

**Owner-provided 2026-09-03 card-charge evidence** (pasted 2026-09-03).
Filed in
[`docs/source_intake/HOUSEHOLD_CARD_CHARGE_EVIDENCE_2026-09-03.md`](docs/source_intake/HOUSEHOLD_CARD_CHARGE_EVIDENCE_2026-09-03.md).
Coverage is ~7 months (2026-02-02 → 2026-09-03), not 18–24. Discovery is
not authorization: Phoenix, Mailchimp, Calendly, AICHATAPP,
Shopify, card interest, and repeating shopping were **not** added to
`plan.bills`. Amazon Prime membership was later owner-promoted
(2026-09-22) as the one `plan.bills` row `amazon-prime` ($11.19 monthly
on the 19th, Travel Visa, firstDue 2026-09-19). The separate $24.63
Prime-like charge and ordinary Amazon shopping stay outside that row.
Candidate promotion of the other merchants remains a later
owner-confirmed one-outcome PR, not a silent follow-on from this filing.

~~**Owner-instructed recurring card-charge audit** (2026-09-03). Discovery
only: `scripts/recurring-audit.js` inspects mapped revolving-credit Lunch
Money history and reports repeating merchants. It does not create or
promote Forecast bills. Phoenix / Amazon household conclusions require a
live GET-only run; synthetic tests are not household evidence.~~ Removed
2026-11-17 by owner decision (group B), with Grok Bot's agreement (rule 17):
no saved workflow called it. Its two standing rules keep their homes in
`docs/ACCOUNT_FACTS.md` (Amazon on Travel Visa) and the `data.json`
dale-guilt-free `why` (Cursor).

**Follow-ups from the 2026-08-16 evidence pack** (not mixed into that
facts PR; each needs its own independently provable outcome):

- **Noble quarterly expander** — **DONE.** Forecast `occurrences()` expands `frequency: quarterly`. Canonical `noble-garbage` is the one quarterly row.

- **HELOC residual PAD** — **DONE 2026-08-18.** Q19 ANSWERED: the Aug. 14 $1,100 payment satisfies the $814.18 August minimum. Do not invent a duplicate August cash minimum.

- **Historical Telus in the telecom remainder** — **CLOSED 2026-08-18.**
  TELUS IS CLOSED. Future Telus cost is $0. Historical Telus spending remains in the record; the remainder-split planning blocker is removed.

- **Bell baseline vs card-paid current bill** — **DONE.** Forward Bell standing is the dated $160.00/month row on the 15th from firstDue 2026-10-15 (`plan.bills` `bell`). Owner 2026-09-21: planned paying account is BILLS ACCOUNT (Chequing A), a joint-cash withdrawal. September 2026 is the once row `bell-sep15-2026` $283.94 due 2026-09-15 and stays card-paid Travel Visa. The June $104.20 + watch $16.80 = $121.00 reconstruction is historical. Q18 stays OPEN for settlement state.

- **Unresolved once cash obligations across a later Forecast start** —
  owner instruction 2026-08-18. A known unresolved cash obligation still
  on the plan must remain binding when Forecast start advances past the
  placeholder date used to reserve it. Advancing as-of is not settlement.
  Not a new backlog number; not the first production cutover.

**Critical path** is owned by
[`docs/ATLAS_FINANCIAL_BUILD_STRATEGY.md`](docs/ATLAS_FINANCIAL_BUILD_STRATEGY.md),
not by this file. Forecast-critical work through `B96`, plus `B20`, `B21`,
`B78`, `B79`, `B80`, and `B81`, is **done**. Unattended production writes,
scheduled refresh, and a newer live substitute opening remain reserved. A
production Lunch Money token is authorized for on-demand GET-only
observation (2026-08-23), not for canonical writes. Do **not**
wait for a second month of routine statement files. Provider-completeness,
broad historical forensics, old categorisation cleanup, and file-statement
backfill are not critical-path gates unless they expose a demonstrated
material source or financial-correctness gap.

**Operational knowledge lives in `docs/ACCOUNT_FACTS.md`**, not here: how each
institution's data is obtained, the download endpoints, and the traps that cost
time (TD's dead download button, MBNA's mirrored signs, the browser pane needing
to be visible, merchant strings needing normalising before matching).

---

## 🔴 The two that undercut everything else

**B70 · The HELOC limit is a planning boundary: $0 headroom means $0 additional borrowing** · **DONE / RESOLVED 2026-08-18** · *owner planning invariant; engine already held it*

HELOC available credit is borrowing capacity, never household cash or safe-to-spend. Unapproved borrowing cannot repair an otherwise-infeasible plan. Direct regression proofs live in `test-master-forecast.js` and `test-opening-gap-no-auto-borrow.js`. 2026-08-21 live overlay confirmation: [`docs/connectivity/LIVE_ACCEPTANCE_2026-08-21_NO_AUTO_BORROW.md`](docs/connectivity/LIVE_ACCEPTANCE_2026-08-21_NO_AUTO_BORROW.md).

**B71 · Triangle Mastercard limit risk on the published 2026-08-19 opening** · **REOPENED 2026-08-21** · *Forecast.projectDebts crosses $13,500 on day 0; 2026-08-16 under-limit result retired*

**Reopened, not an engine defect.** The 2026-08-18 resolution was that
Triangle **remains under** the $13,500 limit on the then-canonical B91
2026-08-16 opening (`firstOver` null). The published opening is now
2026-08-19. `Forecast.projectDebts` on that opening returns a Triangle
crossing on **2026-08-19 at day 0**. Forecast and the Plan page already
publish that crossing; this entry was the stale copy. B71 is a live
recorded risk until a later opening or payment changes the deterministic
result. No Forecast, `data.json`, or Plan-page change is required.

**KNOWN.** Canonical 2026-08-19 opening in `data.json`: posted
**$13,495.32** + pending **$0.00** = exposure **$13,495.32** against a
**$13,500.00** limit. Headroom **$4.68**. `Forecast.utilisation` reports
available **$4.68**, **99.97%** used, `overLimit` false at the opening
mark (the walk is under at the snapshot; interest takes it over the
same calendar day). Purchase APR **21.99%** / cash **22.99%**. Next
modelled minimum **$253.57**, `firstDue` **2026-09-07**, confidence
**estimated**. That headroom is **credit, not household cash**. B70
remains the planning boundary: it never increases safe-to-spend; $0
headroom would mean $0 additional borrowing capacity.

The 2026-08-16 opening — posted $13,197.00 + pending $15.62 = exposure
$13,212.62, headroom $287.38; `projectDebts` `firstOver` null; peak
$13,388.86 on 2026-09-06 ($111.14 of headroom); 91-day ending $13,178.74;
Aug. 10 $300 already inside that posted (independent identity:
13,497.00 − 300.00 = 13,197.00) — is retired dated evidence, not current
truth.

The 2026-08-09 opening — posted $13,497.00, $3.00 of headroom, day-90
$227.71 over-limit projection — is also retired evidence, not current
truth.

**Deterministic Forecast result (current 2026-08-19 plan; no invented purchases).**
On both the 91-day view and the 365-day knowledge horizon,
`projectDebts` reports Triangle `firstOver` **2026-08-19**, `day` **0**,
`alreadyOver` **false**. Opening used is under the limit; same-day
interest takes it over. 91-day ending balance **$13,475.95**. An
independent daily ledger — opening posted+pending, 21.99%/365 interest,
modelled 7th-of-month payments from `firstDue` — agrees with Forecast to
the cent: day-0 interest **$8.13** lifts the balance to **$13,503.45**;
peak modelled exposure is **$13,650.64 on 2026-09-06**, the day before
the first modelled $253.57 payment ($150.64 over). `Forecast.planPhases`
already emits `facilityCrossing` for Triangle on 2026-08-19;
`public/plan.js` renders that risk. The 2026-08-18 claim that the card
**remains under** the limit is **not** current and is retired with the
16 August opening.

**RISK.** Interest consumes the remaining headroom (~$8/day at this
balance; roughly $243/month against the estimated $253.57 minimum). Thin
room before the September payment is real: on this opening it is already
the day-0 crossing. Additional real-world purchases are not on the
deterministic path and Atlas does not invent them; they could produce a
worse result.

**UNKNOWN.** Issuer-specific over-limit treatment or fee. No Triangle
over-limit fee is observed in available committed evidence. That is not
a finding that Canadian Tire Bank charges none, and it is not modelled
as $0. The evidenced $29 over-limit fee belongs to the TD Cash Back Visa,
not Triangle.

**B63 · Where do the coach payments leave from?** · BLOCKED · *small*

Coaching money is **pass-through**: a remitter sends it, coaches are paid out of
it, the household keeps the margin. Her sheets put the coach share at **27.7%**.

But the 30 June remittance of **$9,646.25 went onto the HELOC the same day**, in
full, and **no coach payments appear in either mailbox**. Three readings:

1. She pays from an account not yet captured — most likely, see B64
2. Coaches were paid earlier or on a lag
3. They have not been paid from this money — an **unrecorded liability**, spent
   on a facility that does not amortise

**Partly answered:** **one coach is paid by cheque** from DEBT&PAYMENTS
(owner-stated) — $8,150 across five cheques, Feb–Nov 2025. So coach payments were
never going to appear as e-transfers, and the mailbox search was looking for the
wrong instrument.

**But the cheques stop in November 2025**, while her sheets show $6,397.50 of
coach pay between April and August 2026. **The 2026 route is still unidentified**
— most likely the account in B64.

**Partly answered again, 9 Aug 2026.** Recovering the deleted Interac
notifications produced a payment that had been invisible: **$2,160.00 on 6 July
to a named individual**, out of SAVINGS-DONT TOUCH, **four days after the
$9,646.25 remittance landed there** — 22.4% of it, against the 27.7% coach share
her sheets imply. A second, **$1,064.92**, went to another named individual on
5 August. **So the "unrecorded liability" worry is substantially reduced**: the
pass-through money was not simply absorbed by the HELOC.

What is still open is the rest of the route. This is one payment out of one
remittance, and the earlier conclusion that no coach payment existed was wrong
only because the evidence was in the bin — which is a reason to fix **B66**
before the next remittance rather than after it.

**Second lead:** a **Payworks** pay-statement notice, 29 Jun 2026. If the coaching
business runs payroll, the rest of the coaches are paid through it.

**The liability worry is softened but not closed.** Coaches are demonstrably paid;
what is unproven is whether the 30 June remittance was passed on before the
$9,646.25 went onto the HELOC.

**B64 · Amanda's other account** · BLOCKED · *small*

**Confirmed to exist by elimination**: $186.16 arrived in Chequing A on 14 Jul
2026 and **no $186.16 left any of the six captured accounts** that week. Interac
names only the receiving bank, never the sender, so the notification cannot
identify it. Her mailbox shows no other bank since **CIBC in 2019**.

Routes, cheapest first: **ask her** · check whether the old CIBC account is still
open · **pull a credit report**, which lists every open account and is definitive.

Prime candidate for where coach payments leave from, and for one of the **two
unidentified accounts** ($59,027) — the larger sent $33,598 across **142**
transfers, a frequency that fits paying a roster far better than anything else
considered.

---

## Blocked on the household

**B70 · Agree a standing transfer from Amanda's account** · **CLOSED 2026-08-22** · *small, high value*
Owner-confirmed 2026-08-22: the two fixed Tennis BC salaries land in
household accounts and are already Forecast household income. Coaching
surplus is transferred only after coaches/business obligations are paid
and is not a base-plan transfer. The live `$1,100` standing-transfer
action is retired. Do not put a fixed Amanda-transfer instruction back on
`plan.actions`. Historical ad-hoc crossings remain dated evidence; Q25
stays OPEN only for the coaching/business remainder.

**B13 · Business records — revenue and cost of goods** · *large*
Owner-stated 2026-08-29: no shop/resale/inventory business; seasonal coaching
leftover is gravy, not Forecast income. Historical receipts vs coach pay vs
HELOC-funded outbound remains Q1 OPEN. Do not invent a margin or split. Do
not treat planning settlement as a Q1 close. Dental-lab rent ended (see Q5).

**B56 · Separate the two businesses** · *medium*

The 2026-08-09 split still stands as dated evidence: parents' dental lab
(garage rent to May 2026) versus Amanda's seasonal coaching. Owner-stated
2026-08-29: coaching is not a resale/inventory shop; leftover is gravy, not
a Forecast income line. Historical coaching net remains Q1 OPEN.

| | Whose | What |
|---|---|---|
| **Dental lab** | her parents' | in the garage; paid rent to May 2026; "not going well" |
| **Coaching** | Amanda's | remitted in bulk; coaches paid out of it |

Business costs sit on household cards — `Head Canada Inc.` $1,043.37 is a
coaching expense Amanda absorbs personally (owner-confirmed), and the Travel Visa
mixes household, holiday and business on one card.

**B57 · The garage rent — is it coming back?** · *small*
$1,000–1,100/month from Mar 2025, stopped May 2026. **$12,600/year gone**, and
because it was misfiled as an internal transfer its loss never registered as an
income event. **Business use of the home** may affect insurance and creates both
a possible deduction and a capital-gains exposure — an accountant's question, and
they have one.

**B58 · The five cheques — $8,150** · **LARGELY ANSWERED 2026-08-09**
**Amanda pays a coach by cheque** (owner-stated). That fits: **all five were
written from DEBT&PAYMENTS**, her account, not the joint one.

| Date | Amount |
|---|---|
| 18 Feb 2025 | $980.00 |
| 15 Jul 2025 | **$3,010.00** |
| 9 Sep 2025 | **$2,835.00** |
| 27 Oct 2025 | $30.00 |
| 19 Nov 2025 | $1,295.00 |

The three large ones are term-sized at a $35/hour coach rate — $3,010 is 86
hours, $2,835 is 81. The $30 is something else.

**But they stop in November 2025.** There is not a single cheque in 2026, while
her tracking sheets show coaches being paid **$6,397.50 between April and August
2026**. So the cheque route was replaced — which points hard at **B64**, the
account outside the captured set.

**Still worth TD's cheque images** to confirm the payee, but the mechanism is no
longer a mystery.

**Also found: a `CHQ RETURN FEE` of $2.00 every month on DEBT&PAYMENTS**, 18 of
18 months, including months with no cheque written. **$24/year for a service that
went unused after November 2025.** Add to the fees dashboard (B30) and to the
account-plan review (B24).

**B59 · Coinbase** · *small*
Owner no longer uses it; recorded as dormant and excluded from net worth.
**Dormant is not empty** and the account is still open — statements were issued
as at June 2026. One look at the balance closes it permanently.

**B60 · Phishing against the Coinbase account** · **owner action** · *small*
Two emails from `info@afius.org` styled as Coinbase, 24 May and 11 Jun 2025,
**both carrying the identical code 523469** — a real one-time code never repeats.
Being unused makes the risk worse, not better: nobody is watching it. Closing the
account is the clean fix; otherwise a unique password and app-based 2FA.

**B27 · RESP holdings** · *small*
Balance $31,555.85 known; holdings, book value and contribution room are not.
Access needs OTC Markets and CME/S&P exchange agreements — **an owner decision,
never an agent's**.

**B51 · Narrow the home valuation** · *small* · planning set 2026-08-29; verified value remains Q3
Owner decision 2026-08-29: planning estimate **$1,200,000**; **$1,300,000** is
optimistic high only, not the plan. The 2026-08-09 $1.1m–$1.4m range and the
2026-08-21 $1.3m planning figure are dated evidence. Q3 stays OPEN until a
comparable the owner accepts as verified, a municipal assessment, or an
appraisal. A lender orders its own appraisal regardless.

**B43 · PayPal #2 — confirm account type** · *small*
Inferred personal from its transactions, not verified.

**B14 · Decide whether the business and her employment stay in scope** · *small*

---

## Ready — analysis, nothing blocking

<a id="active-prepaid-bill-close"></a>

**A bill paid before the active period's payday opening is deducted again from that close** · **ADDED TO BACKLOG — OPEN** · *H2-7, Gemini hunt 2 (#821 7091517953); retired by desk ruling and lead, #1594 closed without merging (7098398666)*

Known cautious limit: a bill paid in the previous period is already out of the payday opening, yet the active period's close still deducts it. Gemini's invented case closes at 3800 against 3900, so the close understates by up to the bill and never overstates. The cause is that `prepaidBillSettledBy` is set only for future periods, so an active row falls back to its scheduled date in `paidBillAlreadyInPaydayOpening`.

Design for a later attempt, from the reviews on #1594:
- `paidBillAlreadyInPaydayOpening` stays the one decision. An active row gets its posting date only when every check below holds:
  - the walk's own settled set holds the row;
  - it passes the future gate's `coversOccurrence || verifiedSettles`;
  - it is not a scheduled fee allowance;
  - the tie is the provider's own match (`occurrenceLink: 'provider-matched'`, #1587's label, reused unchanged);
  - the tie is to exactly one natively posted (`pending: false`, `savingsPostingEvidence: 'posted'`), positive Bills-account debit, dated before the payday opening.
- PAID status and the assigned bill load do not change.

Proof required (the desk's acceptance): from raw invented Lunch Money rows through observer, overlay and Forecast, show that
- the native match waives exactly one active-close deduction;
- the waiver carries through to the next opening and the s1 seed;
- an otherwise identical early-date inference, and a removed link, get no relief.

The two gaps that retired #1594 are the next item, and a raw world in which Atlas's rule path produces an inferred tie for a Bills-paid bill.

The s1 variant (Gemini's H2-7 note a) shares this root and gate. Under the s1 seed (`s1CurrentBillsStockCents`, Bills stock as of the as-of date), a bill posted inside the active period before as-of but due after it is deducted again. That can push the seed below 0 and leave the next opening and the Savings closing null. The same gate applies with the posting date compared to the as-of date instead of the payday opening, and the proof bar is the same.

<a id="null-sweep-prior-period-debit"></a>

**The payday sweep and next opening go null when a prior-period debit for a bill exists** · **ADDED TO BACKLOG — OPEN, investigate** · *found while proving H2-7 (#1594 7098398666)*

In an invented raw world (Bills bill of 100 due 10-28, payday 10-23 with a snapshot opening, as-of 10-23), main publishes a calculated active close (3300). Yet its `paydaySweep` is null, so the next period's opening is unknown. This happens whenever a debit for that bill posted in the prior period (10-20) exists, whether or not the ledger ties it to the occurrence. Without that debit, the sweep and the next opening are known (2900). It may be a deliberate withholding or a real bug. Find which input withholds the sweep, then either name it on the period or fix it. Proof would be the same invented world showing the sweep and the next opening known, or withheld with a stated reason.

<a id="satisfied-minimum-future-close"></a>

**A satisfied card minimum already in cash is deducted again from a future cash close** · **ADDED TO BACKLOG — OPEN** · *H2-5, Gemini hunt 2 (#821 7091517953); desk ruling (Plan #6) adopted (2), and #1589 was closed without merging (7096030824)*

Known cautious limit: a future card minimum keeps its Planned row with money sent shown separately. When Forecast's settlement decision proves the issuer satisfied that exact statement occurrence and the sent debit is already in the household cash, the future period's cash close (`paydaySweep` / `plannedPeriodClose`) still deducts the minimum. The close can therefore understate cash by up to one minimum, never overstate it. #1589 tried a relief and drew three blockers in a row: a carry-forward from a payday snapshot taken before the debit; a cutover walk seeded by a balance dated before the debit; and a split send, where the seed check read only one of several contributing debits.

Design conditions from the ruling, for any later attempt:
- Use the settlement decision's full set of contributing debits, never a record re-derived from the first send.
- Prove that each of them is included in the funding-account balance that seeds that close. If any one cannot be proven, there is no relief.
- Keep the Planned row, the planned bill load and Balance After Deductions unchanged; only the cash close may move.

Proof would be invented split-send, pre-debit-seed and carry-forward controls that get no relief, beside one fully proven case whose close moves by exactly one minimum.

<a id="linked-posted-bill-payment"></a>

**A pending copy of a linked, posted bill payment blocks Stack's Paid check. Expected: the bill stays Paid.** · **ADDED TO BACKLOG — OPEN** (C1 Check 6.19)

The defect is in Forecast. The observer links the posted debit to its bill occurrence and marks the posted member of the duplicate pair. In `public/forecast.js`, `budgetBillPostedLink` rejects that member on `pendingPostedDuplicate`. Forecast then publishes pending evidence and `stackBillPaid: false`; the Bills card renders that verdict. In the invented scenario, removing only the duplicate flag on the posted debit restores `posted-equal`, the Paid check and the posted amount in the paid total.

The occurrence stays settled once. Collapse a pending copy into the posted payment. If the extra debit is a distinct charge in the already-settled cycle, send that charge to To confirm. Keep the classic Paid-row and settlement totals until Stack proves both cases. The lead owns the ledger-side disposition under OD-021.

**Item notes split on ";" only, so an `item:` note followed by an appended line is misread** · *latent; ATLAS REVIEWER observation on #1497 (7053019186), lead 2026-11-20; ledger-side, rule 17*

`noteItemNames` (`scripts/provider-observe.js`) splits a Lunch Money note on ";" only. A note that holds an `item:` line and then a newline-appended line (for example Grok Bot's appended "bill verified") reads the appended text as part of the item name. No figure or rule reads item names today, so nothing published moves. Decide with Grok Bot whether item notes are separated by ";", by lines, or by both, then split the same way the bill marker does. Proof would be an invented note `item: widget` followed by an appended line, which yields the item name `widget` alone.

**A card purchase that Lunch Money labels as a movement counts in neither Budget nor Bills** · *pre-existing; Stack Wallet A2 coverage check (#1426, lead 2026-11-19); ledger-side, rule 17*

A household's card spending reaches Balance After Deductions and the Stack Wallet surplus only through the Household budget hold (budgetHold, including Other Spending) or the bill load. A card debit that Lunch Money files under Transfer or Credit Card Payment is classed as a movement, not spending, so it counts in neither. Issuer interest charges are also outside both, by design (debt-side; the card minimum carries them). Measured on the invented card-coverage aggregate world: a 40 card purchase labelled Transfer or Credit Card Payment moves no figure, while the same purchase uncategorised, in a named category with no budget row, or with no category, moves the hold by 40. Atlas reads the ledger's label and builds no reclassification (rule 17), so the fix is the label: decide with Grok Bot whether such debits need a ledger check. Separately, the comment above the Other Spending row in `calendarHouseholdBudget` (`public/forecast.js`) still says named non-calendar categories "stay omitted"; since Dale's 2026-11-11 rule they join Other Spending (`householdBudgetSupportingRows`), so the comment should be corrected in the next engine PR that touches it.

**U6 blanks the whole plan for an early salary-evidence credit the run-up hold already counts once** · **awaiting owner decision (stop 2)** · *LEDGER B read-only check, 2026-11-19; lead ATLAS LEAD 11 holds it for Dale*

After #1405, an early or off-amount credit with no sign of salary is held To confirm by Forecast's run-up hold: the plan stays live and the payday counts once. The same credit with a sign of salary (a salary-alias payee) still trips U6 (`futureIncomeUncertainty`, provider-observe), which makes the operating plan Unavailable, so income, Balance After Deductions and the planned close read Unavailable. Invented check on the test-amanda-pay-early-plain-credit world (control 3600 / 3200 / 7700): a salary-alias 2190 on Oct 27, or a 2200 on Oct 22, reads all Unavailable; the same 2190 Payroll-filed with no salary sign reads 3600 / 3200 / 7700. Converting those U6 cases to the run-up hold would turn a published Unavailable plan into calculated figures, a tag move toward more certainty, so it is Dale's call under owner-reserved stop 2. If approved: U6 skips a credit the run-up hold covers, reading the same Forecast-exported window, and keeps withholding where the hold cannot answer.

**An unproven payday beside a held early salary credit is counted by neither** · *known cautious limit of the early-salary-credit run-up hold (LEDGER B, 2026-11-19)*

Forecast holds an income credit in an unproven salary occurrence's run-up (the day after the income's previous occurrence, or one cadence interval back for a first occurrence, to 3 days after the date) To confirm, not relied on, when the credits together reach half the paycheque; the occurrence is counted once, and a held leg dated before a period's opening is not added again at its close. Once the payday passes with no identity proof, the occurrence is not received and the credit is still held, so neither is relied on: the live figures understate by up to one paycheque, never overstate. Likewise, where two unproven occurrences' run-ups both hold a pre-opening credit, a credit larger than the nearer paycheque counts its excess against the other, which understates if the credit was the nearer one's. A held credit whose membership in the cash a close starts from cannot be proved (a same-day credit on a posted-balance opening, a credit on a completeness walk's base day or in its gap, or one whose account is unknown) withholds that close and every later opening (early-receipt-membership-unproven) rather than guessing. Decide whether a passed, unproven payday should release the held credit (Grok Bot owns the confirmation, rule 17). Proof would be an invented early pay whose payday passes unproven and reads once, at the credit's amount.

~~**Card payment pairing: a payment-like card credit pairs with a TD debit without reading the debit's note** · *pre-existing; #1298 review obs 4 (a), lead 2026-11-18*~~ · **CLOSED 2026-11-19** (lead ruling: the note is the bank-side identity; no card credit pairs with a debit noted for another card, and the credit withholds; test-card-payment-note-conflicts.js)

In `reconcileCardPurchases` (`public/forecast.js`), a card credit that is payment-like through its own fields pairs with an equal TD household debit without checking that debit's note, so a debit whose note names a different card can still pair with it. Decide whether a conflicting debit note should withhold the pair, as the group step does. Proof would be an invented TD debit noted for one card beside an equal payment-like credit on another, which pairs with neither.

~~**Card payment pairing: a payDown destination silently wins over a different note card** · *pre-existing; #1298 review obs 4 (b), lead 2026-11-18*~~ · **CLOSED 2026-11-19** (lead ruling: neither wins; the debit pays no card and is held To confirm once as 'card-payment-destination-conflict'; test-card-payment-note-conflicts.js)

When a household debit carries a payDown destination and its note names a different card, the payDown destination wins with no withhold or diagnostic. Decide which one is the authority, or whether the conflict withholds. Proof would be an invented debit with a payDown to one card and a note naming another, read the chosen way once.

~~**Card minimum category versus a note naming another card** · *#1407 finding; lead ruling, ATLAS LEAD 11, 2026-11-19; NEXT after grouped Savings card payments*~~ · **DONE 2026-11-19** (#1412, b29f36a2: card identities that disagree, whether payee, minimum category or note, pay neither card; test-card-minimum-category-note-conflict.js)

A debit filed in a "Minimum payment - <card>" category (household minimum confirmation, `cardMinimumOwnedDebits` / card-minimum-category.js) whose `card payment:` note definitely names a different contract card still counts toward the category's card. Ruling: same principle as #1407. The category's card and the note's card conflict, so the debit counts toward neither card's minimum, is held To confirm once, and the minimum stays to-confirm. Proof would be an invented minimum-category debit noted for another card, held once, with neither minimum covered.

~~**Name Seaspan's pay item and retire the payroll late-posting stopgap** · *Q1 closure; NEXT once the reviewed Lunch Money item for Dale's pay exists (lead asked Money, 2026-11-18)*~~

~~Q1 (agent/seaspan-pay-lm-matched) lets the payroll rule settle from Lunch Money's own recurring match: a linked deposit settles the payday LM paired it to, early, on time or late, once, at its actual amount. FOUNDATION: the household payroll rule names no item yet. Closure, one PR:~~
- ~~add the reviewed biweekly item's id to the `payroll` rule in `docs/connectivity/transaction-identity.json` (`lunchMoneyRecurringIds` + `settlementFrom: lunchmoney-matched-occurrences`);~~
- ~~remove `payrollLateOfEarlier` (#1290's one-business-day stopgap in `futureIncomeUncertainty`, `scripts/provider-observe.js`) and its cases in `test/test-payroll-late-posting.js`, and drop the `businessDaysAfter` export if nothing else reads it.~~

~~Since #1325 the matcher settles a plain payroll credit one business day late itself, so the stopgap only keeps the plan live for an exact-amount late credit the matcher declines: a competing same-identity credit, a credit that also fits another income, or a payroll rule that is not the plain shape (`test/test-payroll-late-hold-off-remaining.js`). Removing it before LM's pairing decides those would blank the plan in each. Until then the stopgap stands aside only in an observation where LM's pairing took charge of payroll; with no consistent read it applies as before. Proof: the private exact base/head diff, LM's expected dates against Forecast's paydays for 12 months, then Dale's walk (rule 15). Closure is reached when the late-Monday case stays live through the LM pairing and the payday reads received rather than To confirm.~~

Retired (lead, 2026-11-18): no LM recurring item exists for payroll (Grok Bot, 2026-11-18); payroll stays on payee/TENNIS evidence; Q1's opt-in stays dormant. No item is to be created (payee evidence already works), so the payroll rule names no item and the late-posting stopgap stays as #1339 narrowed it.

~~**Linked savings-item spending is carried when actuals coverage is lost** · *#1323 review (rank 18), 2026-11-18; ADDED TO BACKLOG*~~

~~`savingsItemCycleSpend` is deducted from Balance After Deductions and the planned close only when `budget.spentReady` is true. When actuals coverage is lost, or one category is withheld, the item term is 0 while the linked charges (kind `savings-item`) are out of every category and Other, so the household cash carried to the next period does not deduct them. The gate is deliberate on main ("linked equals unlinked": an unlinked category purchase is not counted by the lost-coverage hold either), so both understate together. #1323 repaired only the held-outflow term, whose twin was Other spending (which the lost-coverage hold does count). Next action: decide whether known posted linked charges are carried out of cash on the lost-coverage paths, as held outflows now are, with a hand-derived carry test. Owner: lead.~~ Closed, no code change (lead, 2026-11-18): verified that nothing published understates. A linked charge needs a Savings pool, whose S1 seed is null under lost coverage, so the close and next opening are withheld; an unlinked category purchase IS counted by the lost-coverage hold, so the "both understate together" premise was wrong. Pinned by `test/test-savings-item-lost-coverage.js`; the forecast comment is corrected.

~~**A grouped Savings card payment counts** · *lead U5 ruling, 2026-11-18; ADDED TO BACKLOG from the U5 PR*~~ · **DONE 2026-11-19** (#1408: a grouped Savings debit pays the card once, as a grouped Bills debit)

A Lunch Money card-payment group (U5) counts only with a household-cash debit (Bills or Weekly). A group of a Savings (household-reserve) debit and a card credit withholds as "another shape" (`coverage-payment-group-unconfirmed`), although the same payment ungrouped already pairs (owner rule: money onto the card counts from Savings). Next action: decide whether a grouped Savings debit proves the destination like a grouped Bills debit, and if so admit `household-reserve` in `cardPaymentGroup` and the group step of `reconcileCardPurchases` in `public/forecast.js`, with a hand-derived test. Owner: lead.

~~**LM v2 split pieces keep their split identity** · *lead v1/v2 field check, 2026-11-18; ADDED TO BACKLOG from #1306*~~ Done by `agent/lm-v2-split-identity`: `normalizeLunchMoneyTransaction` reads `split_parent_id` / `is_split_parent` into an internal split identity that only `droppedRowCategory` checks (never `parentId` or the group-parent rules); `test/test-dropped-row-category.js` covers it.

~~Lunch Money v2 (spec 2.11.2) returns split pieces with `split_parent_id` (and the parent with `is_split_parent`, which `GET /transactions` omits by default). `normalizeLunchMoneyTransaction` in `scripts/provider-observe.js` reads only `parent_id`, and since #1306 the v2 `group_parent_id`, so a v2 split piece has no `parentId`. Nothing double-counts, because the split parent is not returned. The one effect is that `droppedRowCategory`'s "no split identity" exclusion misses a split piece whose amount is unreadable, so its gap is localized to its category instead of withheld globally. Next action: read `split_parent_id` into a split identity the dropped-row rule checks, without feeding it to the group-parent rules. Owner: lead.~~

**A pending card payment encumbers household cash** · **DONE 2026-11-19** · *#1401 finding (i); lead dispatch, ATLAS LEAD 11, 2026-11-19*

A pending household-chequing debit filed as a card payment (#1388's unproven class, or an identified card payment) was classed transfer or card-payment and never joined `pendingCash`, so From-today funding published money that had already left for the 1–3 days before it posted. It now joins `pendingCash` (`pendingCardPaymentEncumbers`), and From-today withholds as it does for any pending debit. A pending own-account transfer (TD reference pair), a represented bill and posted rows are unchanged; test-pending-card-payment-encumbers.js.

**A lone pending bill payment off its due date stays deducted beside the reserve** · **DONE 2026-11-19** · *lead dispatch 2026-11-18; ADDED TO BACKLOG from #1319*

A pending identity debit within a still-due bill's near-due reach, with nothing posted yet, is ordinary spending while the bill also stays reserved (`nearDueBillCandidateIds` takes posted debits only: "unresolved pending cash keeps its incumbent path"). In the invented #1319 world that reads 800 where once is 900. It is the cautious direction and ends once the payment posts: #1319 then deducts it once. Next action: decide whether a lone pending identity debit near a due bill is held To confirm on that bill while pending (without settling it), keeping the claim and gap checks cautious as #1319 does. Owner: lead. Done (lead ruling 2026-11-19, agent/pending-bill-payment-held-once): held To confirm on that bill while pending (`nearDueBillCandidate.pendingDebit`), counted once, not settled; the category remaining claim stays classified-incomplete while it is pending and the opening-to-payday gap stays unproven. Two pendings for one bill, one pending that fits two bills, or a posted identity debit within reach keep the incumbent path.

**B97 · Read-only assistant access to Atlas** · **IN PROGRESS 2026-08-29** · *owner instruction; OAuth MCP connection slice*

Owner instruction 2026-08-24: expose one secure, read-only, sanitized assistant data surface backed by the incumbent live Atlas/Forecast authorities. First slice earned: `GET /assistant/current` via `scripts/assistant-packet.js`, dedicated `ATLAS_ASSISTANT_TOKEN` Bearer secret. Owner decision 2026-08-29 authorises the OAuth infrastructure specifically required for ChatGPT. `POST /assistant/mcp` exposes that packet as `get_atlas_current` behind OAuth issuer/JWKS, exact-resource, expiry, and `atlas.current.read` validation. PR #476 adds four separately scoped Lunch Money tools for catalog, transaction lookup, preview and explicitly confirmed category/notes/split corrections under the 2026-10-02 owner addendum in `ARCHITECTURE.md`. Atlas is only the resource server; the external issuer owns login, consent, PKCE, client registration and tokens. Browser, static-assistant, and OAuth credentials remain separate. No second planner, transaction store, money movement or canonical Atlas write. Owner request 2026-10-02 now extends the existing catalog to all provider-returned synced/manual account balances, including savings, with exact signed decimals, currency, balance date and separate sync metadata. Missing values stay unavailable, provider-reported trust stays unknown, and no combined cash/debt or spendable total is invented. Implemented/tested in the account-balance PR; merge awaits exact-head systems review, then deployment and read-only catalog verification. Existing tool count and OAuth scopes are unchanged.

**B98 · Lookahead ten-block still prints debt and big-purchase rows** · **DONE 2026-09-22** · *Plan presentation only; found 2026-09-03; PR #404*

The household Plan waterfall now ends at Balance after household budget (owner
instruction 2026-09-03). The week / next-period lookahead ten-block behind
"More views" in `public/plan.js` still prints Credit card to pay off first,
Other credit cards, Balance after debt repayment, Big purchases on the horizon
and Balance after big purchase allocation. Those rows are $0 extra / no
set-aside on lookahead spans by Forecast design. Decide with the Credit and
Planning content PRs whether that view also stops at the household-budget
boundary. Not a Forecast change.

**B105 · Financial Trajectory Slice 2 — named dated income-regime split** · **DONE 2026-09-16** · *owner instruction; Forecast-only compose*

Dale authorized a Forecast-owned read-only monthly cash+debt baseline over the incumbent `knowledgeHorizon`. Slice 1 earned `Forecast.baselineTrajectory` (planned `weeklyVariable`, coupled `projectDebts`, 2027 named unavailable). Slice 2 replaces the blunt `year≥2027` blanket with a named dated fail-closed split in that function only: current modelled Dale net through 2026-12-31; Dale payroll/bonus from 2027-01-01 unavailable (deposit-year CPP/EI reset), not $0 and not the `expandEvents`-carried 2026 post-CPP/EI-max net. Trajectory-local `isDalePayrollStream` cutoff — global `expandEvents` / `simulate` / `recommend` / `knowledgeHorizon` / weekly caps are unchanged. Dale/Seaspan-owned bonus uses those same ownership signals; Amanda/other bonus stays modelled. Owner planning facts such as a 2027 raise are omitted from runtime until canonical plan data contains them. Slice 2 left `incomeRegimesImplemented` false. B105b replaces the 2027 Dale unavailable with an evidence-derived ESTIMATED Seaspan payroll regime where that evidence supports one.

**B105a · Planning page reprints baselineTrajectory** · **DONE 2026-09-16** · *owner instruction; presentation only; PR #317*

`public/planning.js` reprints `Forecast.baselineTrajectory` monthly income, month-end cash, and coupled debt marks — status, amounts, and unavailable notes only. Every horizon month prints, including 2027 months Forecast marks estimated or unavailable with notes. No simulate / expandEvents / recommend math on the page. Talk Ask NL trajectory templates remain deferred.

PR #318 (assistant packet / Talk context seam — not B105a Planning scope) merged 2026-09-16T04:10:43Z to `fb7566cf`: `scripts/assistant-packet.js` projects the same reprint as `planning.trajectory` on `GET /assistant/current`, MCP `get_atlas_current`, and session `GET /talk/context`. Merge Card Atlas Contract / Systems Review was **REQUIRED** with review outcome **PENDING** on tip `61229b23bd31c3a5445200e0ada6568026d1cf81`; GitHub reviews show Codex **COMMENTED** only — no Atlas Contract PASS review body found. Owner explicit merge authorization merged that head while review outcome remained PENDING.

**B105b · Financial Trajectory — 2027 Dale estimated payroll regime (trajectory-local)** · **DONE 2026-09-16** · *owner instruction; Forecast-only compose*

`Forecast.daleEstimatedPayrollDeposits` produces an evidence-derived ESTIMATED Dale/Seaspan payroll regime across the 2027 boundary for `Forecast.baselineTrajectory` only. Current modelled 2026 net stays on the operating plan. 2027 deposits use the incumbent Seaspan biweekly calendar, last observed raise anniversary 2026-02-22 (not a hard-coded March 1), owner-authorized planning assumptions from `plan.payrollPlanningAssumptions` (+4% raise, 18% bonus of $158,091, authorized through 2027), and last-published 2026 CRA statutory tables as a labelled planning assumption because 2027 YMPE / EI / federal indexation were unpublished. The estimate fails closed after 2027 until a later regime is authorized and independently proved. Represented id@date actuals replace the matching estimate only when that occurrence can settle into the current opening. Trust stays estimated; never promoted to verified. `incomeRegimesImplemented` is true only when that Seaspan-evidenced regime is ready. Streams without Seaspan salary evidence stay fail-closed unavailable. Talk templates, Planning UI redesign, recommend/ranking, and production writes remain out of scope.

**B105c · Financial Trajectory Outcome 1 — objective pressure signals on baselineTrajectory** · **DONE 2026-09-16** · *owner instruction; Forecast-only compose*

`Forecast.baselineTrajectory` publishes walk-derived `pressure.signals` from the existing daily cash series, `expandEvents`, published month-end cash, coupled month-end debt marks, and incumbent `projectDebts.crossings`. Signal kinds: `lowest-projected-cash`, `cash-trough`, `cash-sign-change`, `month-cash-decline`, `outflow-exceeds-inflow`, `dated-commitment`, `debt-increase`, `debt-not-declining-after-payment`, `debt-limit-crossing`. `cash-sign-change` is the first strictly negative published close after the last strictly positive close, including a walk that passes through exact $0; zero is the walk's sign identity, not a comfort threshold. `dated-commitment` trust is the weaker of the commitment input and the cash walk — an estimated input is never published as calculated. `debt-limit-crossing` is withheld when revolving pending exposure is unknown and the posted opening is not already over the limit. Each signal describes a mechanical fact the walk can establish. No household minimum-cash, breathing-room, safe-to-spend, RYG, risk-score, or affordability threshold is invented; unpublished cash or debt months fail closed with no invented signals. Ranking / recommendation stay null. Read-only. Planning reprint of pressure, Talk templates, debt-direction, scenarios, and proactive discovery remain out of scope. Cause attribution is Outcome 2 / B105d, not this item.

**B105d · Financial Trajectory Outcome 2 — cause attribution on pressure signals** · **DONE 2026-09-16** · *owner instruction; Forecast-only compose*

When `Forecast.baselineTrajectory` identifies an objective pressure signal, it also publishes mechanical cause attribution on that signal from the same walk. Drivers are closed candidate classes the events, Household Budget daily drain, and coupled debt marks can prove: `income-timing` (with two-pay / three-pay cadence as a fact where a single stream has 2 or 3 pays in the window), `household-budget`, `recurring-bills`, `debt-payment`, `debt-interest`, `dated-commitment`, `bonus-timing`, `mortgage-or-major-obligation`, and `payroll-deduction-regime` facts from estimated deposit records that keep the same gross and change deductions. Ready attribution reconciles driver amounts to the named trajectory change. Unmapped cash movements, opening-level cash that is not a walk change, facility limit-crossings without an isolatable driver, and non-reconciling classified totals fail closed (`attribution.status: unavailable`, empty drivers) rather than inventing an "other" class, a comfort threshold, ranking, recommendation, or affordability. Helper stays inside `baselineTrajectoryPressure` and is not a second exported engine. Planning reprint of pressure, packet/Talk reprint of attribution, Talk templates, Outcomes 3–5, scenarios, and `Forecast.recommend` remain out of scope.

**B105e · Financial Trajectory Outcome 3 — debt direction / consequence on baselineTrajectory** · **DONE 2026-09-16** · *owner instruction; Forecast-only compose*

`Forecast.baselineTrajectory` publishes walk-derived `debtDirection` from the incumbent coupled `projectDebts` walk already used for monthly debt marks and O1/O2 pressure. As-of `openingBalance` versus the last published month-end mark answers which modelled debts decline, which remain persistent at whole-cent identity (not a comfort band), whether any supported balance increases, interest consequence the coupled walk established, and the first published month-end at which a modelled balance is $0 after a positive opening. Fail closed when no published debt mark exists; unpublished months contribute no invented direction. Planned Household Budget weeklyVariable does not manufacture future card borrowing. Available credit / headroom is not cash. Helper stays inside Forecast and is not exported. No ranking, recommendation, affordability, or owner-policy threshold. Planning reprint of debtDirection, packet/Talk reprint, Talk templates, Outcomes 4–5, scenarios, and `Forecast.recommend` remain out of scope.

**B105f · Financial Trajectory Outcome 4 — additional-debt-payment scenario against the same baselineTrajectory walk** · **DONE 2026-09-16** · *owner instruction; Forecast-only compose*

`Forecast.baselineTrajectoryScenario` publishes a Forecast-owned read-only consequence for one caller-supplied explicit additional debt payment against the identical planned Household Budget / knowledgeHorizon / Dale estimated payroll walk `Forecast.baselineTrajectory` already builds. The caller supplies `nature: additional-debt-payment` plus amount and debtId (Slice 6 finite-numeric whole-cent and eligibility rules). Nothing is inferred from cash, buffer, HELOC funding, `plan.nextDollar`, `plan.decisionPosture`, or Gemini. Forecast composes the shared internal walk helper plus `projectDebts` / `simulate` hypotheticalExtra-style absorption; it does not call `Forecast.hypotheticalExtraPayment`, `Forecast.counterfactuals`, or `Forecast.recommend`. Baseline key, scenario walk, and cash / named-debt / interest deltas come from those walks. Unpublished cash is omitted, not $0. Fail closed when the trajectory baseline would be unavailable, the debt is ineligible, or the input is incomplete. Ranking, recommendation, and affordability stay null; action permission is not granted; writesCanonicalState is false. The helper is not a second exported planner. Planning / packet / Talk reprint, Talk templates, Outcome 5, inferred money moves, commitment edits, mortgage-renewal rates, min-cash / breathing-room / safe-to-spend / RYG, and production writes remain out of scope.

**B105g · Planning page reprints baselineTrajectory pressure signals** · **DONE 2026-09-16** · *owner instruction; presentation only*

`public/planning.js` reprints `Forecast.baselineTrajectory.pressure.signals` from the incumbent `planningTrajectory()` call when `pressure.status === 'ready'`. Plain-language labels for closed signal kinds; Forecast date/month/amount/trust/id/asOf copied when present; estimated vs calculated visible; Forecast order preserved. Unready pressure prints Forecast `pressure.reason`, not a blank success. No attribution, debtDirection, scenario, ranking, or page-side pressure math. Packet/Talk reprint, O5 discovery, and remaining O4 scenario classes remain out of scope.

**B105h · Planning page reprints pressure signal attribution** · **DONE 2026-09-16** · *owner instruction; presentation only*

Under each reprinted pressure signal, `public/planning.js` copies `signal.attribution` when Forecast published it on `Forecast.baselineTrajectory.pressure.signals`: ready attribution prints attributed change, driver classes/amounts/count/id/label/date, and facts in Forecast order with plain household labels for closed driver classes; unavailable attribution prints Forecast `attribution.reason`; a missing attribution object is unavailable, not invented. No page-side attribution math, no ranking, no debtDirection/scenario/packet/Talk reprint. Forecast-only compose of attribution remains in `forecast.js` only.

**B105i · Planning page reprints baselineTrajectory debt direction** · **DONE 2026-09-16** · *owner instruction; presentation only*

`public/planning.js` reprints `Forecast.baselineTrajectory.debtDirection` from the incumbent `planningTrajectory()` call when `debtDirection.status === 'ready'`: household opening/ending/delta and direction, consumer/secured/HELOC breakdown when published, declining/persistent/increasing id lists, `anySupportedIncrease`, `inventedBorrowing`, and `availableCreditIsNotCash` when Forecast publishes them; per-debt opening/ending/delta/direction/paid, interest when calculated or unavailable reason when not, and `cleared-within-published-horizon` milestones when Forecast published them — Forecast order preserved, plain language, no ranking or payoff-order recommendation. Unready debt direction prints Forecast `debtDirection.reason`, not a blank success. No page-side direction math, no scenario, no packet/Talk reprint. O5 and remaining O4 scenario classes remain out of scope.

**B105j · Financial Trajectory — three-stage selected-period funding decomposition on baselineTrajectory** · **DONE 2026-09-16** · *owner instruction; Forecast-only compose; PR #329*

`Forecast.baselineTrajectory` publishes a Forecast-owned three-stage funding decomposition on each already-published calendar month from the same `prepareBaselineTrajectoryWalk` events plus the planned Household Budget `weeklyVariable` already applied by incumbent `simulate` on the walk days in that month. Stage 1 (normal life) is projected income − joint-cash recurring bills − required debt obligations − planned Household Budget (walk-applied `weeklyVariable / 7` for each simulate day in the month, not a separate calendar-month smear). Stage 2 (after planned spending) is Stage 1 − dated non-optional commitments. Stage 3 (after debt strategy) is Stage 2 − planned extras from `plan.defaults.extraDebtMonthly` / walk `kind:'extra'` only, including honest $0. Same underlying trajectory walk; no second calculator; no residual balancing bucket. Component totals and results are reconcilable; trust follows existing trajectory calculated/estimated/unavailable rules and is never promoted. Ranking / recommendation / affordability / min-cash / breathing-room / safe-to-spend / RYG stay null. Unavailable income or cash for the month fails closed, not $0. Stage 3 does not invent extras from `baselineTrajectoryScenario`, payday true-surplus, or `plan.nextDollar`. Pay-period series, Planning / packet / Talk reprint, other O4 scenario classes, Outcome 5, and paydayAllocation operating-sheet changes remain out of scope.

**B105k · Planning page reprints baselineTrajectory three-stage funding** · **DONE 2026-09-16** · *owner instruction; presentation only*

`public/planning.js` reprints `Forecast.baselineTrajectory` `stage1` / `stage2` / `stage3` for a household-selected trajectory month from the incumbent `planningTrajectory()` call: Normal life, After planned spending, After debt strategy with Forecast labels; component totals and results copied when present; estimated vs calculated chips preserved; unavailable stages print Forecast `reason`, not $0 or implied surplus. No page-side stage arithmetic, no scenario, no packet/Talk reprint. Monthly cash/debt table, pressure, attribution, and debtDirection reprints stay intact.

**B105l · Financial Trajectory — Forecast-owned pay-period series on baselineTrajectory** · **DONE 2026-09-16** · *owner instruction; Forecast-only compose*

`Forecast.baselineTrajectory` publishes a Forecast-owned Seaspan payday-to-payday `payPeriods[]` series from the same `prepareBaselineTrajectoryWalk` / `simulate` / `projectDebts` walk the monthly series already uses. Each published pay-period is an incumbent `spendingCycle` window (payday through the day before the next Seaspan payday), clipped to the knowledge horizon the same way months are clipped — not calendar 1st–15th / 16th–month-end halves, and not a second cash engine. Each row carries the same three-stage funding decomposition (Normal life → After planned spending → After debt strategy → projected result) via the shared span helper: Stage 1 income − joint-cash bills − required obligations − planned Household Budget (walk-applied `weeklyVariable / 7` on simulate days in that pay-period, not a 14-day smear); Stage 2 − dated non-optional commitments; Stage 3 − `plan.defaults.extraDebtMonthly` / walk `kind:'extra'` only, including honest $0. Trust follows the same calculated / estimated / unavailable span-end Dale-payroll rules as months; unavailable is not $0. A missing Seaspan payroll calendar fails the pay-period series closed (empty; provenance `unavailable`) and does not withhold months. Ranking / recommendation / affordability / min-cash / RYG stay null. Stage 3 does not read `baselineTrajectoryScenario`, payday true-surplus, or `plan.nextDollar`. Planning / packet / Talk reprint of the pay-period series, dashboard compose, Outcome 5, and scenario UI remain out of scope.

**B105m · Planning page Month ↔ Pay Period trajectory funding views** · **DONE 2026-09-16** · *owner instruction; presentation only*

`public/planning.js` exposes a Month / Pay period control on the trajectory three-stage funding section from the incumbent `planningTrajectory()` call. Month view reprints `Forecast.baselineTrajectory` `months[]` `stage1` / `stage2` / `stage3` for a household-selected calendar month; Pay period view reprints `payPeriods[]` stages for a household-selected Seaspan pay period — same baseline walk, two Forecast-published granularities. Component totals and results copy when present; calculated vs estimated chips preserved; unavailable stages print Forecast `reason`, not $0 or implied surplus. No page-side stage arithmetic. Monthly cash/debt table, pressure, attribution, and debtDirection reprints stay month-scoped and intact. Packet / Talk reprint, `public/forecast.js`, dashboard compose (O3), scenario UI, and Outcome 5 remain out of scope.

**B105n · Planning page — Your Financial Road Ahead trajectory dashboard compose** · **DONE 2026-09-16** · *owner instruction; presentation only; Trajectory Dashboard Campaign Outcome 3*

`public/planning.js` / `planning.html` compose the household Planning first screen **Your Financial Road Ahead** from the incumbent `planningTrajectory()` → `Forecast.baselineTrajectory` call only. Lead: first forward negative `stage3.result` when Forecast publishes one (projected funding gap wording) else first forward `pressure.signals` fact; timeline: published `stage3` projected results by Month or Pay period with the existing granularity control; selected period: three-stage funding progression plus per-period pressure in disclosure. Full cash/debt table, legacy funding picker, all pressure signals, debt direction, and future costs sit in progressive disclosure. No `public/forecast.js` edits; no sustainable/safe/RYG/min-cash/affordability/recommendation cards; no page-side stage or pressure math. Scenario UI (O4) and Outcome 5 remain out of scope.

**B105o · Planning page — extra-debt-payment scenario on Road Ahead** · **DONE 2026-09-19** · *owner instruction; presentation only; Trajectory Dashboard Campaign Outcome 4*

`public/planning.js` remounts the incumbent extra-debt-payment helpers under Road Ahead as a secondary disclosure after the breakdown (not a leftover primary what-if quarantine). Household supplies an explicit eligible debt id and whole-cent additional payment; `planningTrajectoryScenario` calls only `Forecast.baselineTrajectoryScenario`; Baseline vs Scenario projected cash, named-debt walk marks, interest, and Forecast `delta` are reprinted. Idle is the baseline-only preview (not Forecast-unavailable). Reset restores idle. Baseline timeline and stage3 stay on `Forecast.baselineTrajectory`. No plan mutation, inferred amount/debt, ranking, page-side scenario arithmetic, payday / Prepare Ahead / Budget change, or `public/forecast.js` edit. Proof: `node test/test-planning-page.js`, `node test/test-planning-road-mobile-presentation.js`, and `npm test`. Outcome 5, packet/Talk reprint, and other scenario classes remain out of scope.


**Road Ahead standalone surplus/deficit** — **DONE 2026-09-22.** Owner direction: each Month and Seaspan pay period funds itself. `stage3.result` identity `standalone-period-surplus-deficit` excludes prior-period surplus. Cumulative walk close stays on `cash` and is not the Road Ahead result. No savings allocator.

**B104 · Decision Intelligence comparison foundation** · **IN PROGRESS 2026-09-15** · *owner instruction; Forecast-only compose of Slice 6*

Dale authorized a Forecast-owned read-only comparison of two or more caller-supplied explicit hypothetical extra debt payments from one identical household baseline. It composes `Forecast.hypotheticalExtraPayment` per scenario. It does not rank, recommend, infer affordability, apply `decisionPosture`, or write. Talk / Gemini / UI and `Forecast.counterfactuals` are out of scope. Unavailable underlying scenarios fail the comparison; unavailable is not zero.

**B103 · Talk to Atlas household surface** · **RETIRED 2026-11-11** · *owner decision #821 comment 6786692208: the Talk page, its `/talk/*` routes and `ATLAS_TALK_GEMINI_API_KEY` were removed. History below.*

Dale authorized Talk Slice 1 on 2026-09-14 via Atlas Coordinator: an authenticated household-facing Talk page (UI shell and sixth household dock destination). Slice 2, authorized the same day, is the session-only `GET /talk/context` seam that serves the incumbent `scripts/assistant-packet.js` packet to that page. Talk JS shows packet metadata only (available / unavailable, as-of, freshness/trust already on the packet). Slice 3, authorized the same day, is the session-only Gemini explainer turn (`POST /talk/ask`, model `gemini-2.5-flash-lite`, dedicated `ATLAS_TALK_GEMINI_API_KEY`). Gemini explains incumbent packet facts and must not plan, calculate, or invent numbers. Send enables only when that key is configured. Owner reported the dedicated Render secret set the same day; the value is not in git and this record does not read it. Slice 4, authorized the same day, is presentation only: verified claims are mapped through Atlas templates into a clean household answer plus optional provenance, trust/as-of/freshness, and one existing-route link. It does not change `/assistant/current` or `/assistant/mcp` auth, and does not publish new figures. Production acceptance on tip `5ea78bda` found a Slice 4 BLOCKING: narrow `metadata.effectiveAsOf` succeeded, but broad period / bills / credit asks returned HTTP 502 because one unverifiable claim failed the whole turn. The authorized repair keeps the extractive contract and fail-closes planner-act extra-cash asks; it does not start Slice 5. Slice 5, authorized the same day, records owner-authorized aggressive-but-not-brittle household decision policy as `plan.decisionPosture` (closed labels plus owner provenance; no universal numeric threshold) and projects those labels read-only through `scripts/assistant-packet.js` onto `/talk/context` and `/talk/ask`. Forecast does not apply that row in this slice. Talk may explain the recorded labels; planner acts still fail closed. Slice 6, authorized the same day, is the deterministic read-only Forecast what-if boundary for one explicit hypothetical extra payment against one eligible debt (`Forecast.hypotheticalExtraPayment`, composing `simulate` / `projectDebts`). It does not apply `decisionPosture`, does not let `plan.nextDollar` replace the caller-named target, and does not add Talk NL extract, a server route, or a write. Slice 6B, authorized the same day, is the Talk adapter: Gemini extracts only `{ intent: hypothetical-extra-payment, amount, debtLabel }`, the server validates the amount and resolves one stable eligible id, and Forecast remains the sole calculator. Planner-act / missing-amount / missing-target / ambiguous-Visa asks stay unavailable. A-vs-B Talk Decision Intelligence, authorized 2026-09-15 via Atlas Coordinator: authenticated Talk presents `Forecast.hypotheticalExtraPaymentComparison` for two or more explicit caller amount+named-debt pairs. Gemini extracts only those pairs; the server question-verifies, pairs amount to target, and resolves ids. No ranking, recommendation, affordability, decisionPosture choice, or writes. Talk A-vs-B preference judgment, authorized 2026-09-15 via Atlas Coordinator: when the caller asks preference over an already-earned explicit two-option A-vs-B, Talk applies the owner rule to those Forecast comparison figures only (same household cash-ending, both extras fully absorbed, strictly greater named-debt interest reduction) and presents PREFER or NOT YET / INDETERMINATE. Preference judgment is exactly two scenarios. B103 Slice 4, authorized 2026-09-15: after exactly one unambiguous already-earned A-vs-B in the current Talk session, a bare “Which one?” refers to those exact two options and invokes only that incumbent preference contract. Multiple comparisons, 3+ options, amount/target ambiguity, an unearned prior, leftover / bills / hypothetical last turns, or current data that invalidates the reference fail closed. Gemini/history may resolve the referent only and cannot choose the winner. Existing explicit prefer-grammar still works. Slices 2–3 were skipped; Slice 5 is not started. Forecast comparison of two or more extras is unchanged. A 3+ option preference ask is NOT YET / INDETERMINATE and does not emit PREFER. Gemini does not choose or change the winner. Conversational preference only — no payment, transfer, borrow, HELOC draw, application, or action authority. Structured answer cards are Queue PR 1 (presentation of already-trusted Talk fields). Citations / provenance are Queue PR 2: the server attaches household-facing citations from allowlisted Atlas surfaces and the same trusted source/trust/as-of fields already on the presentation; Gemini cannot invent them. Queue PR 3 is ephemeral multi-turn session context: a server-held, session-keyed, TTL-bounded RAM buffer for conversational follow-ups. History is not household-financial evidence, not Forecast state, not owner policy, and not a durable store. Queue PR 4 is safe progressive Talk presentation: allowlisted status events, then the same verified `/talk/ask` payload. Gemini tokens are not streamed. Deterministic Why? explanation, authorized 2026-09-15 via Atlas Coordinator: Talk may explain an already-published Atlas/Forecast result by tracing existing verified inputs and provenance. Gemini may extract only `{ intent:"why" }` plus an optional allowlisted `referentPath` or `referentKey`; the server builds the explanation from packet fields and presentation templates. Gemini must not invent causes, numbers, or policy. A why-ask without a publishable referent is unavailable. Owner-gate repair on PR #306: a Why? of a prior hypothetical or comparison keeps that published Forecast as-of / freshness, or fails closed when the baseline is missing; it does not stamp the current packet onto an unrecomputed result. A why-ask whose referent is not yet determined may reach Gemini extract; last-presented / planner-act / missing-baseline stay unavailable. Not a second planner, not a Forecast calculation change, and not a durable memory store. Verified follow-up references, authorized 2026-09-15 via Atlas Coordinator campaign PR3: campaign-style deixis (next payday, that card, interest again) may resolve only against ephemeral structured refs from a prior verified Talk presentation and must re-read the current packet or recompute Forecast. Conversation prose is not financial truth. Ambiguous deixis is unavailable. Hyp/compare inheritance and Why? last-presented stay in force. Payday leftover, authorized 2026-09-15: Talk reprints Forecast-owned `paydayAllocation.runningLeftover` for “what does this payday leave us with?” and for an unambiguous leftover “what does that leave us with?” earned from a verified payday leftover presentation. Gemini extracts leftover intent or referent only. Unavailable leftover is not $0. Not a waterfall, bills list, purchase what-if, or recommendation. Payday operating picture, authorized 2026-09-15: Talk reprints the existing Forecast-owned `paydayAllocation` leftover stages and leftover-consuming allocated amounts for “what does this payday look like?” Presentation and composition only. Talk does not invent a second payday model or reconstruct stages by subtracting. A leftover “what does that leave us with?” still uses the #309 leftover contract when leftover was earned from that verified look-like presentation. Not a period bills list, purchase what-if, causal balance-why, write, Forecast math edit, or recommendation. Payday remaining bills Slice 1, authorized 2026-09-15 via owner Talk dispatch: authenticated Talk reprints Forecast-owned `currentPeriodAction.bills` for “What bills are coming before next payday?” and close cousins (still left this pay period / covered / is X still due?). Settlement is Forecast-owned (represented / upcoming / unverified). Gemini extracts remaining-bills intent, covered/last-presented referent, or caller-named billLabel only. Talk does not date-filter the period, rebuild schedules, invent a paid list, or treat unverified as unpaid. Unavailable remaining is not none. Not a purchase what-if, leftover math, waterfall, recommendation, write, Forecast redesign, or slices 2–5.

**B99 · Modellers / Deep Dive / Records still carry the legacy four-link nav** · **RETIRED 2026-11-16** · *the pages are deleted (Dale's direction); their paths redirect to `/`*

The household nav is Budget | Forecast | Bills | Subscriptions | Credit | Plan spend. `modellers.html`, `deepdive.html`
and `records.html` remain routable but their own header still links Plan |
Modellers | Deep Dive | Records. The household floating dock is scoped to
`sitenav-household` so those diagnostic pages keep the four-link text nav;
that CSS leak from PR #268 is not a decision about their future. Their future
(household nav, a diagnostics nav, or retirement) is owner direction; do not
delete them on an agent's initiative.

**B102 · Current-cash treatment of pending spending outside essential target lines** · **MERGED 2026-09-06 via PR #263** · *same cash-identity blocker, owner-directed repair*

The earlier safe-follow-up disposition was incorrect. Unresolved household-cash
pending in Other Spending, discretionary categories, and essential categories
without a positive target could reach extra debt or optional residual while
still owed to a merchant. PR #263 now retains all admitted observed pending
cash principal once at `Forecast.paydayAllocation`'s incumbent protected-cash /
surplus-release boundary. Category consumption, targets, posted opening, and
frozen calendar arithmetic remain unchanged. No category promotion or bill
is invented; card exposure and settlement use incumbent authorities.

Independent regression failed PR head `3d27740a9f65e002e8bb8a783f6272ae68e6b26a`:
$5,000 posted cash minus $900 future essentials minus $250 pending released
$4,100 rather than $3,850. Repair proves $3,850 in each category, whether
pending or settled with $4,750 posted cash, through extra debt, optional,
unallocated, and mixed destinations. Positive essential pending $600 retains
$600 principal plus $300 future groceries, converging with $4,400 posted cash
and $300 future groceries after settlement. The exact final head `3e12dbc9f526a7197ca0542f7ac3eb2826f7a955` received Atlas Contract / Systems Review PASS on 2026-09-06, and PR #263 merged the same day (merge commit `b5df202e23252368a4a46d4d4f51fdf9ac791268`). This is one root cause and one repair, not deferred work.

**B101 · Plaid pending→posted identity is not Lunch Money `id`** · **DONE 2026-09-04** · *financial-correctness interruption; owner instruction after live Amazon authorization/settlement investigation*

Live Lunch Money v2 only returns `plaid_metadata` when `include_metadata=true`. Atlas was requesting `include_pending` and the unbounded `is_pending` universe without that flag, treating Lunch Money `id` as `providerTransactionId`, and matching `posted.pendingTransactionId` to the pending Lunch Money id. Plaid's contract is `posted.plaid_metadata.pending_transaction_id === pending.plaid_metadata.transaction_id`, and the posted amount may differ. Current-period household spend/remaining and revolving pending exposure can double-count one purchase. Not Amazon-specific, not merchant fuzzy matching, not a new identity system. Forecast remains the planner.

**B100 · Figures snapshot does not cover the Credit and Planning surfaces** · **DONE 2026-09-04** · *governance; found 2026-09-03*

`scripts/figures-snapshot.js` now snapshots Plan, Credit, and Planning
household-facing figures. Credit keys copy `Forecast.creditAccounts` (balance,
pending, limit, utilisation headroom, rate, next minimum / due, HELOC
capitalise and cash minimum). Planning keys copy the same `Forecast.recommend`
`majorPlans` / `paydayAllocation` / `knowledge` the Planning page renders
(verdict, remaining, point or range, timing, allocated / not-assigned). Deep
Dive, Records, and Modellers remain outside. Not a Forecast change. Proved by
`test/test-figures-snapshot-credit-planning.js`.

**Dated 2026-08-09 BNPL reviews still combine Affirm and Flexiti** · **READY** · *docs only; not live current truth*

Dated 2026-08-09 reviews still print `Affirm / Flexiti` as one unknown BNPL line:
`docs/00_MASTER_PICTURE.md`, `docs/FINANCIAL_REVIEW_2026-08-09.md`,
`docs/MORTGAGE_HELOC_DEEP_DIVE.md`, `docs/dashboard.html`,
`docs/SANITIZED_SUMMARY_2026-08-09.csv`. They do not render as current on the live
Records / Deep Dive path (those pages read `data.json`). Do not rewrite them as
current truth. Owner instruction 2026-08-31 separated the live sources.

**B66 · Stop deleting the Interac notifications** · **owner action** · *small*
**The single cheapest fix in this file.** Interac's confirmation emails are the
only record of who is on the other end of an e-transfer, and both mailboxes are
deleting them. Gmail purges the bin after 30 days, so the evidence is being
destroyed on a rolling cycle — 26 of the 49 attributions recovered on 9 Aug were
sitting in the bin and would have been gone within weeks.

A filter on **both** accounts — `from:payments.interac.ca` → apply a label, skip
the inbox, **never delete** — costs nothing and makes every future transfer
attributable. It cannot recover what has already gone.

**B68 · Two auto-insurance policies at once** · **owner action** · *small*
**ICBC $99.91/month started 21 April 2026 and BCAA $82.96/month never stopped.**
Both are charged on the 15th, every month since. Auto insurance went from $82.96
to **$182.87/month — an extra $1,199 a year** — and nothing marks it as a
decision. If BCAA is optional coverage on top of ICBC basic Autoplan, fine. If it
should have ended when the ICBC policy began, one phone call recovers it.

**B69 · Home insurance — $3,131.76 a year, paying card still unknown** · *small*
Square One, policy #5157890, **auto-renews 10 February**, whole year in one
payment. **Owner 2026-09-18:** the 2026-02-10 payment processed on a credit
card. Forecast now publishes it as dated yearly card-paid `plan.bills`
`square-one` (next **2027-02-10**). **Still open:** which card / account
paid it — it appears in none of the six accounts or five captured cards.

Two further things: the premium is up **~17% in a year** ($2,730.36 → $3,131.76),
and the **January 2025 payment failed twice and the policy came within days of
cancellation**. A lapse on a mortgaged property is serious, and a single $3,131.76
debit is exactly the kind that fails when an account is short. Also worth asking
the insurer about the garage — see B57.

**B67 · The $1,806.00 Fusion invoice** · *small*
Invoice 86995864, 31 Aug 2025, paid by Dale — **and it appears in none of the
six accounts or five cards**, though it falls inside both coverage windows. The
other seven Dale-paid invoices predate card coverage and are explainable; this
one is not. Most likely an invoice total settled in instalments too small to
spot. One look at the LeagueApps payment history closes it.

**B28 · Rewards balances as minor assets** · **PARTIAL 2026-08-21** · *small*
Travel Visa **57,968 TD Rewards points**; Cash Back **$47.21**.
The dollar-denominated Cash Back Dollars **$47.21** now sit on `data.json`
`assets` and enter household asset / net-worth presentation through
`Forecast.publicationTotals`. That figure is the **2026-08-09** account
reading, not the 2026-08-19 opening; `docs/positions.csv` holds the dated
Household evidence. They are not spendable cash and not a funding source.
**Still open:** the 57,968 TD Rewards points have no single valuation basis
in current repository authority and are **not** assigned a dollar value. Do
not invent cents-per-point, a redemption method, or a rewards engine.

**B72 · `test-mergecard.js` names a commit that no branch holds** · **DONE 2026-08-22** · *housekeeping*

CLOSED. Current `test-mergecard.js` uses `const HEAD = 'a'.repeat(40);`. No code change was required. The string `b85274ce` survives only in historical prose.

**B73 · Financial decisions made inside page scripts** · **DONE 2026-08-14**
Every recorded page-script financial decision moved into Forecast. The item is closed on that recorded set; a new page-side decision, if one appears, is a new finding.

**B74 · Two calendars, and nothing notices when they disagree** · **DONE 2026-08-14**
PR #37. One authoritative household cash schedule: `data.json` `plan` → `Forecast.expandEvents`. Owner-confirmed 2026-08-24: the recurring CMAW Local 1995 $25/month payment is cancelled. AF-REFRESH-01 retired the monthly Plan bill and kept the 15 August once row; the 2026-08-25 live closed-loop receipt represented that occurrence from evidence without writing canonical state. AF-REFRESH is closed.

**B87 · One authority for question OPEN / ANSWERED status** · **DONE 2026-08-14**
`docs/01_OPEN_QUESTIONS.md` is the sole OPEN / ASKED / ANSWERED / BLOCKED authority. Q2 stayed OPEN in that PR. Proved by `test-question-status.js`.

**B88 · Tests must not depend on checkout line endings** · **DONE 2026-08-14** · *housekeeping*
Newline identity is normalized at the test input boundary (`test-source-text.js`). Proved by `test-line-endings.js`.

**B89 · Stop storing derived publication totals** · **DONE 2026-08-14** · *small*
`Forecast.publicationTotals` derives published totals from canonical rows. Proved by `test-publication-totals.js`.

**B90 · Guard overlapping essential / discretionary classification** · **DONE 2026-08-14** · *small*
Comparable essential/discretionary overlaps must agree or be named. School & clubs disagreement is Q24. Proved by `test-classification.js`.

**B91 · Evidence refresh / reconciliation loop** · **DONE 2026-08-16** · *architecture, current-state cutover*
Non-writing reconciliation over existing observation records; owner-approved edits land in `data.json` and Forecast consumes them. B91 closed on the 2026-08-16 cutover, which remains dated evidence in `snapshots/2026-08-16.json`. The live published opening is **2026-08-19**. Q19 is ANSWERED 2026-08-18.

**B92 · Make ordinary evidence refresh cheap** · **DONE 2026-08-14** · *tests, one outcome*
Behaviour tests no longer pin live household numbers; live cents remain only in deliberately live reconciliation. Proved by `test-refresh-isolation.js`.

**B93 · Derive or delete proven duplicate live facts** · **DONE 2026-08-14** · *architecture, one outcome*
Duplicate live facts derived or deleted. Q25 stays OPEN: the raw TENNIS INCOME balance is not household funding. Proved by `test-dedup-facts.js`.

**B94 · One master forecast; ranges are views** · **DONE 2026-08-16** · *engine earned; one outcome*
Forecast is the one master plan over a ≥12-month knowledge horizon; named ranges are views. Proved by `test-master-forecast.js`.

**B95 · Absorb known major future costs onto the master plan** · **DONE 2026-08-16** · *canonical plan / evidence absorption*
Known major future costs live on `plan.commitments`. Proved by `test-major-future-costs.js`.

**B96 · Prove the payday question end-to-end** · **DONE 2026-08-16** · *after B94; one outcome*
Household payday answer is composed from Forecast. Proved by `test-b96-payday.js`. Q19 is ANSWERED. Q20 / Q25 stay OPEN and fail-closed.

**B75 · Nothing checks that the authority table is complete** · **DONE 2026-08-11**
PR #10 added `test-authority-coverage.js` to the blocking `npm test` suite.

**B76 · The scope tripwire counts implementation only** · *needs a decision, not a fix*
`CLAUDE.md`'s scope budget counts **implementation** files and **implementation**
lines — source, workflows, templates — and counts documentation separately. For a
documentation-only pull request the tripwire therefore contributes nothing: there
is no numeric prompt at all, whether the change is eight lines or nine hundred.
The superseded PR #4 ran to over nine hundred documentation lines and PR A to
458; both were honest, and neither tripped anything.

**This finding is smaller than when it was first recorded, and the framing is
updated rather than carried across.** Scope is now explicitly a reviewer
judgement — the tripwires are "guidance, not merge-card fields and not CI
thresholds", and a reviewer asks whether the pull request is still one
independently provable outcome whether it is under or over them. So the gap is no
longer a gate that passes silently; it is a prompt that never fires for prose.

What remains worth deciding: a long document can carry an unreviewable amount of
authority-changing prose exactly as a long diff can carry code, and nothing draws
a reviewer's eye to that. Any answer should go through the governance-control
lifecycle rather than straight to a number — a new hard control needs a
demonstrated failure it would have caught, a deterministic predicate, a test that
proves the predicate fails on the defect, and a retirement condition. A
documentation line limit chosen without those is the gaming `CLAUDE.md` warns
about, with extra steps. Carried forward from PR #4, which recorded it under an
identifier since reused.

**B77 · The GitHub connector bypasses the pre-commit hook** · **DONE 2026-08-20** · *governance, small*
CI now applies the trusted default-branch copy of `scripts/privacy-guard.js` to every PR head. Adding the `privacy-guard` status to required checks on `main` remains an owner repository-setting action. Proved by `test-privacy-guard.js`.

**B82 · The figures comment claims a wider scope than it checks** · **DONE 2026-08-20** · *governance, small*
The figures comment names the snapshot's actual membership. B100 extended that membership to Credit and Planning; Deep Dive, Records, and Modellers remain outside. Proved by `test-figures-comment.js`.

**Issue #57 remainder · Autonomous delivery loop** · *governance, not a new B-id*

The repair → handoff → GPT-5.6 follow-up → card-sync middle is live as of
PR #63. Duplicate GitHub/Merge-Card primary-risk state closed in PR #64.
Owner granted first REQUIRED GPT-5.6 reviews on 2026-08-16; the first-review
wake-up is this outcome. Standing auto-merge of qualifying `auto-safe` PRs
is granted but must not become operational until GitHub itself enforces
`tests`, `Merge card mechanical fields`, and `risk-label/primary` on `main`.
Next-node wakeup remains later. They do not reorder `B91` and they are not
a slice taxonomy.

**B85 · Evidence-Use Register** · **DONE 2026-08-13** · *architecture, one outcome*
Live CI-checked disposition in `docs/evidence_use/register.json` (PR #28). The register owns routing and parking only; remaining parked IDs live there.

**B86 · Stale biweekly payroll net in the 91-day forecast** · **DONE 2026-08-13** · *figures, one outcome*
Live `plan.income` `payroll` replaced with the observed average **$4,264**, tagged estimated.

**B84 · `ARCHITECTURE.md` keeps its own running count of B73's progress** · **DONE 2026-08-20** · *documentation truth, small*
The second home for B73 progress arithmetic was removed from `ARCHITECTURE.md`.

**B83 · `CONTEXT.md`'s suite table names five of twelve suites** · **DONE 2026-08-12**
Suite inventories were removed rather than reconciled. `test.js` is the suite registry.

**B78 · Idempotent Lunch Money import with stable identity** · **DONE 2026-08-17** · *T3*
Incumbent observe/reconcile path is identity-stable and idempotent on the leftover 2026-08-16 observation. Proof: [`docs/connectivity/LUNCH_MONEY_IDENTITY_PROOF_B78.md`](docs/connectivity/LUNCH_MONEY_IDENTITY_PROOF_B78.md).

**B79 · The store question, answered by evidence** · **DONE 2026-08-18** · *owner-reserved gate stays closed*
The file foundation has not demonstrably failed. No store implemented. Gate remains closed. Written answer: [`docs/STORE_QUESTION_B79.md`](docs/STORE_QUESTION_B79.md).

**B80 · Evaluate connectivity providers, point nothing live** · **DONE 2026-08-16** · *owner brought this forward*
First provider for a personal read-only test: Lunch Money. Written evaluation: [`docs/connectivity/PROVIDER_COVERAGE.md`](docs/connectivity/PROVIDER_COVERAGE.md).

**B81 · Trusted canonical refresh from the live feed** · **DONE 2026-08-20** · *earned capability; production activation reserved*
Earned preview/approve writer, published 2026-08-19 canonical opening, and read-only live overlay. Production on-demand GET-only Lunch Money access is owner-authorized 2026-08-23. Unattended production writes, scheduled refresh, and a newer live substitute opening remain owner-reserved. They are not a missing B81 implementation slice and do not keep this item `IN PROGRESS`.

---

## Ready — needs a session at an institution

**TD EasyWeb.** Route and traps are in `ACCOUNT_FACTS.md`. Retention is ~7 years,
so none of this is time-sensitive.

- **B26 · Personal Visa, August 2025 statement** — 11 of 12; **not aged out**
- **B22 · Savings interest rates** — neither savings account has a captured rate
- **B23 · Chequing B overdraft rate** — drawn every month, cost unquantified
- **B24 · Account plans and fee structures** — $17.67/month across two accounts
  plus $3.95 on DEBT&PAYMENTS. **Some TD plans waive the fee at a minimum
  balance.** One of the few places an immediate saving may exist
- **B25 · Mortgage prepayment penalty formula** — a mortgage advisor will ask
  first
- **Tier 3 · chequing and savings statements**, 12 months each, for fee and
  interest detail. All five accounts are reachable from the same statements
  dropdown

**PayPal.** No monthly statements exist; the equivalent is a PDF activity report.

- **B8 · April–August 2026 gap** on account #1
- **B39 · history before March 2026** on account #2
- **B9 / B42 · per-subscription amounts and billing dates** — 16 and 10 merchants
  known by name only. **Always exhaust "See more"**: two only appeared after
  expanding twice
- **B38 · reconcile authorisations against settlements** on #2, as was done on #1
- **B44 · generate PDF activity reports** for the archive

**B49 · Wise statements** · *small* — activity CSVs held; statements not captured.

---

## Queued behind the above

**B107 · A confirmed part payment against a card minimum** · *medium; rule 17, Grok Bot first*
Forecast cannot take a confirmed payment that is smaller than a statement
minimum off that minimum: a `sentPayments` record that does not satisfy the
minimum makes `cardMinimumState` unavailable for every card (the weekly figure
and the card waterfall step are withheld). Nor can it accept a payment from a
named account outside the household's paying account. Found on the MBNA
November minimum (owner 2026-11-23), recorded instead as the issuer's own
minimum still owing. Outcome: a confirmed part payment, including from a named
non-household account, reduces that one minimum to what is still owed, and the
other cards stay available. Payment confirmation is ledger-side: Grok Bot's
answer comes before any build.

**B15 · Rebuild the income picture** *(on B63)* · *medium*
Owner-stated 2026-08-29: do not add a coaching income line. Forecast uses
salaries (Seaspan, Tennis BC) and the child benefit. Coaching leftover is
gravy when it lands. Historical coach-pay net remains Q1 OPEN. The 2026-08-09
tracking-sheet derivation is dated subset evidence, not a current monthly
coaching-income figure. Do not invent a split.

**B16 · Finish the spending picture** *(on B34, B40)* · *medium*
Cards and chequing are both categorised. Remaining: merge the windows (12 months
of cards against 18 of chequing) and handle the PayPal overlap without
double-counting.

**B40 · Fold Instacart and delivery in** *(on B38)* · *medium*

**B19 · Compose the Deep Dive page `helocHistory` current endpoint from live `debts.heloc`** · **DONE 2026-08-17** · *small*
Closed the Deep Dive page current endpoint, not the historical `docs/MORTGAGE_HELOC_DEEP_DIVE.md` document. Q19 is ANSWERED 2026-08-18.

**B20 · `snapshots/<date>.json` and trend charts** · **DONE 2026-08-17** · *history as a refresh by-product*
Dated openings live in `snapshots/`. T2 holds for the stored HELOC pair.

**B30 · Fees dashboard** · **DONE 2026-08-09** — site section 11.

**B32 · Interest dashboard** · **DONE 2026-08-09** — site section 10.

**B65 · Period selector** · **DONE 2026-08-09** — this month / last month / YTD / all, built by `scripts/periods.js`. Rebuild after every capture or the selector goes stale.

**B21 · Prove the normal Lunch Money refresh path** · **DONE 2026-08-17** · *small*
Owner-run live observe → reconcile proof: [`docs/connectivity/LUNCH_MONEY_REFRESH_PROOF_2026-08-17.md`](docs/connectivity/LUNCH_MONEY_REFRESH_PROOF_2026-08-17.md).

**B29 · Payment calendar** · **DONE 2026-08-09**, **authority closed by B74 / PR #37 on 2026-08-14**
Cash-payment VEVENTs are derived from the Plan via `Forecast.expandEvents`.

---

## After 1.0

New ideas that are not a #821 item 1–7 blocker go here until Atlas 1.0 is frozen.

**The figures page capture should also observe the Stack page's reads** · DONE by C1 S1 (`agent/c1-s1-capture-stack`, ATLAS LEAD 11, 2026-11-21; `docs/RISK_LABELS.md`, `test/test-stack-page-capture.js`; the previous-page keys stay until C1 S7) · was QUEUED (ATLAS LEAD 11, 2026-11-19): a named limit of option A (`agent/figures-capture-classic-view`), not a blocker. Full lane: figures hard-gate machinery, Atlas reviews.
- **Why:** `scripts/figures-page-capture.js` now runs the previous Budget page by its explicit route (`?view=classic`), so making the Stack page the default (B7, #1439) does not shift its Savings observations. Once the Stack page is the page the household reads, the capture covers only the fallback page's Savings consumers, not the Stack page's own reads (the shell's `Forecast.recommend`, the Credit card's `cardPeriodMovements` / `stackCreditLines`).
- **Closure:** at C1, when the previous page retires, retarget the capture at the Stack page (remove `CAPTURE_LOCATION`'s `?view=classic`) and make its observations stable across the Stack page's states, so the page the household reads stays covered. `test/test-figures-capture-classic-view.js` retires with it.
- Source: lead ruling on #1439's figures report, 2026-11-19.

**The Stack page should say why its figures are withheld when settlement evidence is unavailable** · QUEUED (ATLAS LEAD 11, 2026-11-20): to settle before ATLAS-080 is ever activated. Owner: the lead assigns (display). Full lane: it decides what the default Budget page says when figures are withheld.
- **Why:** with `settlementEvidenceStatus` unavailable, the Stack page (the default route once B7, #1439, lands) shows only its title, "Last updated" and "Now". `?view=classic` on the same input says settlement evidence is unavailable and that the dependent figures are withheld. No figure is shown wrongly; the reason is missing, and there is no link to the previous page. It is the same class as Atlas's retained-refresh finding on #1439, which was settled by keeping that case on the previous page. The settlement seam is unconfigured today, so the reviewer reached it only with a malformed status.
- **Closure:** decide, before ATLAS-080 activation, whether this case stays on the previous page (the retained-refresh precedent) or the Stack page states it, within Dale's no-explanatory-text rule. Then prove the default route on that input in a browser.
- Source: ATLAS REVIEWER's non-blocking observation on #1439 at 966b5d1e (comment 7048345776); #1439 Additional finding 7, ADDED TO BACKLOG by ATLAS LEAD 11, 2026-11-20.

**Keep `test/suites.json` sorted by file name, with a check that enforces it** · QUEUED (ATLAS LEAD 11, 2026-11-19): not scheduled until the Stack page switch-over (C1) is done. Light lane: it adds a check and changes no figure code.
- **Why:** every new suite is appended to the end of the manifest, so any two pull requests in flight together conflict on its last lines. The merge queue then dequeues the second, and its builder has to catch up and get a re-review (#1429 after #1431, #1433 after #1429, 2026-11-19). Sorted entries put parallel additions on different lines.
- **Caveat, order is load-bearing today:** `test/test.js` runs the manifest in order ("npm test remains the complete ordered serial reference"), and `test/test-ci-split.js` checks that the CI shard groups retain manifest order. Sorting moves suites between shards and could expose a hidden order dependency between suites.
- **Proof needed:** one PR sorts the manifest and adds a case to `test/test-ci-split.js` that rejects an unsorted manifest. Before it merges, run the full hosted CI on the sorted order and a local `npm test`; any suite that fails only when reordered is a real order dependency, fixed in that suite, never by keeping the old order.
- Source: DISPLAY proposal (a), ATLAS LEAD 11 ruling, 2026-11-19.

**Make the Savings guard machinery pins merge-friendly** · QUEUED (ATLAS LEAD 11, 2026-11-20): figures machinery. Owner: figures machinery (lead assigns). Full lane: it changes how a hard gate stores its pins. Next action: a build dispatch after Atlas's review queue clears.
- **Why:** `test/lib/savings-consumer-contract.js` pins each machinery file (`scripts/figures-comment.js`, `scripts/figures-snapshot.js`, `.github/workflows/figures-review.yml`) as one whole-file sha256, stored on a single line in `test/fixtures/savings-consumer-manifest/guard/machinery/<path>.sha256`. Any PR that adds a field class edits all three files, so two figures PRs in flight always conflict on those one-line hash files, even when git merges the sources themselves cleanly. On 2026-11-19/20 that meant three hand catch-ups on #1441 alone, each resolved only by `node scripts/savings-guard-pins.js --write`. It also left one head untested: the PR was already dirty when it was pushed, so no `pull_request` check ran on it.
- **Proposal:** store machinery the way module residuals already are, one hash per source line. Non-adjacent edits from two PRs then merge without a textual conflict, while any unreviewed change still fails `savings-guard-pins.js --check` and `test-savings-consumer-contract`.
- **Out of scope:** what the guard protects; the review duty to paste the pin diff into the merge card.
- **Proof needed:** a test that a one-line machinery edit still fails the guard, and that two non-adjacent edits merge cleanly and re-pin to the same manifest as one combined edit.
- Source: LEDGER B finding during the #1441 catch-ups, routed by ATLAS LEAD 11, 2026-11-20.

**One Forecast-owned contract for which recon rows a budget row counts** · READY (ATLAS LEAD 11, 2026-11-20): finding only, no fix in this entry. Owner: engine (the lead assigns). Full lane: it touches how Spent is calculated.
- **Why:** the rule "do not count the pending twin of a posted transaction" (`pendingPostedDuplicate && pending && !pendingAmountEstimated`) is decided in several places in `public/forecast.js`:
  - `spentFromRecon`, inside the household budget builder, which sums a category row's Spent;
  - `confirmedHouseholdAmount`, which counts Other spending from the raw transaction through `isPossibleReplacementPending` and the duplicate-id set;
  - `reconRowCounted`, used by `reconMatchesSpent` (#1452), which says whether a row's listed transactions reconcile to its Spent.

  Nearby checks in the same builder test the same pair of fields again. Today they agree on every published recon row: Atlas found no arithmetic difference on #1452 (7031371702). But a change to one site that misses the others would let a page list rows that Spent does not count, or the reverse, with nothing failing.
- **End state (Atlas, #1452):** one Forecast-owned row-selection contract. Spent, the reconciliation flag and any page that lists a row's transactions all read one published decision of which rows count. No membership rule is repeated in a renderer.
- **Fix direction:** replace or derive (CLAUDE.md "Defect classification"), never a permanent reconciliation between copies. Make one predicate, or a published per-row "counted" mark, the single owner, and derive the other sites from it.
- **Proof needed:**
  - a test that the sites cannot disagree, built on invented inputs that include a suppressed twin and a retained estimated pending amount;
  - the figures review unchanged: 0 fields moved;
  - CARDS' #1450 page test still listing exactly Forecast's counted rows.
- Source: ENGINE finding while building #1452; end state named by Atlas in 7031371702; routed by ATLAS LEAD 11, 2026-11-20.

**A field class added on main fails "Which published figures moved" on every open pull request until it catches up** · READY (ATLAS LEAD 11, 2026-11-20): finding only, no fix in this entry. Owner: figures machinery (the lead assigns). Full lane: it is hard-gate machinery.
- **What happens:** for `pull_request` events, the "Post the figures comment" step's constant class list comes from the workflow file on the merge ref, which is the head merged with current main. The snapshot and the public summary are built by each revision's own `scripts/figures-snapshot.js` and `scripts/figures-comment.js`, which run from the PR's base and head. When main gains a field class after a PR's base, that PR's summary declares fewer classes than the step expects. The step's byte-equality check then throws `invalid-public-summary`, and the job fails closed with "Published figures summary failed; raw diagnostics withheld".
- **Seen on #1452:** head 3c4a887d, base 2be7ee0a, after main gained #1441's three Savings projected top-up classes. Jobs 136279654731 and its rerun 136282074283 both failed. Run locally on the same snapshots, the step passed with the head's workflow and threw with main's. A clean update of the branch to main fixed it (a17c828d).
- **Effect:** the failure is fail-closed, so it never lets a wrong figure through. But it blocks every open figures-affecting PR whenever main adds a class, and its message hides the cause.
- **Fix direction:** not chosen here. The choice is the desk's or the lead's.
- Source: ENGINE diagnosis on #1452 (7039383654), accepted by ATLAS LEAD 11, 2026-11-20.

**Show that a card's issuer minimum is met when the fixed-interest payment exceeds it** · QUEUED (ATLAS LEAD 11, 2026-11-20): from the fixed-interest minimum PR (#1498). Full lane: a trust surface.
- **Why:** when a statement's minimum is below the planned fixed-interest amount, the occurrence keeps the row's own `estimated` word, because the planned amount is Atlas's figure and not an issuer fact. Settlement needs a `confirmed` occurrence, so a payment that covers the planned amount reads as sent with the issuer minimum unconfirmed, and the period's Balance After Deductions stays withheld, even though the confirmed statement fact says the issuer minimum was met. Recording the month's statement no longer clears it.
- **Closure:** the page says the statement minimum is met beside the estimated planned amount, from the confirmed statement fact, without changing the planned amount's tag (an estimate is never promoted). Proof on invented data: a statement minimum below the fixed amount, a payment of the fixed amount, the issuer minimum reads met and the planned amount keeps its estimated word.
- Source: ATLAS REVIEWER non-blocking observation 1 on #1498 (comment 7053318897); builder disposition ADDED TO BACKLOG (comment 7053592949, item 3).

**Decide how an owner-set recurring card payment (Triangle TD on the 3rd) is confirmed: cycle window or its own dated transfer** · QUEUED (ATLAS LEAD 11, 2026-11-20): ledger-side, for Grok Bot under rule 17 (the lead takes it to the Plan #6 thread). Not a builder item until Grok Bot answers.
- **Why:** the payment on the 3rd is a fixed bank transfer, but it is matched with the same statement-cycle window every card row uses (`covers-statement-cycle-or-latest-due`). An earlier, larger payment in the cycle can settle the row while the transfer still goes out, and a smaller earlier payment plus the transfer leaves the row still due with neither counted. That is the existing per-occurrence matching behaving as it does for every card row; the successor-row alias rules add nothing to it.
- **Closure:** a ledger-side ruling on whether a fixed recurring transfer should match only its own dated transfer instead of the cycle. Any change is built only as Grok Bot agrees, and a Lunch Money recurring item for the payment (the bill-linking work, #1495) may settle it.
- Source: ATLAS REVIEWER non-blocking observation 2 on #1498 (comment 7053318897); builder disposition ADDED TO BACKLOG, ledger-side (comment 7053592949, item 4).

**Flag a stale fixed-interest snapshot when a card's recorded purchase rate changes** · QUEUED (ATLAS LEAD 11, 2026-11-20): from the fixed-interest minimum PR (#1498). Light lane, unless it reaches a published trust word.
- **Why:** a card row with a fixed-interest rule holds its own balance, rate and date in a snapshot, by design: a refresh never moves the planned amount, and a rate change is applied by re-authoring the snapshot. The card's rate also lives on its debt record, so the two can disagree and nothing flags it.
- **Closure:** a data check (for example in the plan validator) that names the row when the debt's rate and the snapshot's rate differ, never silently recomputes the amount, and never moves a figure. Proof: a config test that the two match today, and a case that names the row when they do not.
- Source: ATLAS REVIEWER non-blocking observation 3 on #1498 (comment 7053318897); builder disposition ADDED TO BACKLOG (comment 7053592949, item 5).

**Read a mistyped `bill not verified` withdrawal fail-safe (looser match for the withdrawal only)** · QUEUED (ATLAS LEAD 11, 2026-11-20): from the `bill verified` note PR (#1497). Ledger-side matching, so the lead takes the matching question to Grok Bot under rule 17 before any build.
- **Why:** a near-miss of `bill verified` fails safe (nothing is confirmed), but a near-miss of `bill not verified` fails the other way: the earlier verification stands. The reader today takes only the exact line form, so a capital letter, a trailing space, a full stop, a colon comment, a double space or `bill unverified` does not withdraw a verification. The test pins that as intended, and Grok Bot writes the exact form with Dale confirming each edit, so it is not a blocker.
- **Closure:** a ruling on a looser match applied to the withdrawal line only (never to the verifying line or any other note), then one outcome with proof on invented notes: each near-miss of the withdrawal reads as a withdrawal, the same near-misses of the verifying line still verify nothing, and a looser match can cost at most a check.
- Source: ATLAS REVIEWER bounded re-review on #1497 (comment 7053346117), non-blocking observation; noted as a follow-up in the lead's disposition (comment 7053570398).

**Owner card-payment records should carry `movementIdentity` (the provider debit hash), not rely on date and cents** · QUEUED (ATLAS LEAD 11, 2026-11-21): the residual from the TD statements PR (#1509). Full lane if it changes which payment settles a minimum.
- **Why:** an owner `sentPayments` record with a label `debitId` consumes a ledger payment only by matching card, funding account, exact posting date and exact cents (`Forecast.minimumCategoryAllocationConflict`). If the ledger re-dates or re-amounts that debit, the record no longer consumes it, and the same payment can settle a second minimum of the card through the category path. The lead accepted this for #1509 because re-dating a two-week-old debit is unlikely.
- **Closure:** owner card-payment records carry `movementIdentity` (`source: lunchmoney-minimum-category` plus the provider debit hash), so consumption follows the debit itself. Proof on an invented ledger: the same payment re-dated by a day still settles only its recorded occurrence, and a record without the identity reverts to today's date-and-cents behaviour.
- Source: ATLAS REVIEWER 2's blocker on #1509 (7056807037), repaired by date-and-cents consumption; residual disposition by the lead (ADDED TO BACKLOG, 2026-11-21).

**Check TD Cash Back's recorded statement close day against its statements** · QUEUED (ATLAS LEAD 11, 2026-11-21): from the TD statements PR (#1509). Light lane unless a published figure moves.
- **Why:** the stored `debts.statementCloseDay` for TD Cash Back does not match the close day observed on its latest statement, and the close day appears to vary between statements. That field sets the card-minimum category path's lookup window, which decides which minimum a categorized payment can settle. One statement does not establish a new fixed day, so #1509 left the field as it was; changing it would not have removed #1509's double-settle, which the review showed is exposed either way.
- **Closure:** decide from more than one statement whether the close day is fixed and record it, or model a varying close (for example from statement dates). Proof on invented data: the lookup window opens on the recorded close for each cycle tested.
- Source: ATLAS REVIEWER 2 on #1509 (7056807037) and the merge card's Additional findings; lead's ask, 2026-11-21.

**Stack-arm boot: the "focus refused" checks still probe the hidden header** · QUEUED (ATLAS LEAD 11, 2026-11-21): DISPLAY's one-liner. Light lane (tests only).
- **Why:** on the Stack arm of `test/browser-boot-treatment.js`, the two during-load "focus is refused" checks (the inertness run and the static phase) still focus the hidden header theme button. They pass partly because it is hidden, not only because the page is inert.
- **Closure:** those checks probe a Stack-page control that is drawn during a held load, or a test shows no Stack control exists to probe then.
- Source: #1506 (merged), merge card Additional findings 1; lead's light-lane review 7055800787. DISPLAY, relayed by ATLAS LEAD 11, 2026-11-21.

**An explicit yearly-bill `goalRef` bypasses `savingsGoal: false`** · QUEUED (ATLAS LEAD 11, 2026-11-21): DISPLAY's one-liner. Full lane if a savings figure moves.
- **Why:** `savingsCombinedBacking` honours a bill's `savingsGoal: false`, but an explicit `savingsEarmarks` pool `goalRef` `{kind: 'yearly-bill'}` naming that flagged bill would still make it a goal. No such `goalRef` exists today.
- **Closure:** a validator rejects that combination, or the `goalRef` path honours the flag, with a test.
- Source: #1505 merge card Additional findings 6, raised from automated pre-review 7056673358 at c8c1f200. DISPLAY, relayed by ATLAS LEAD 11, 2026-11-21.

**When an item is held, the Savings card does not add up on its face** · QUEUED (ATLAS LEAD 11, 2026-11-21): DISPLAY's one-liner. Full lane (a published figure).
- **Why:** when an item has left the card but still holds its share, the card's saved plus unallocated is less than the balance, and the held amount is not a published figure, so the card does not add up as a reader adds it.
- **Closure:** the held amount is published (or the card shows it), and the identity saved + held + unallocated = balance is checked on the published figures.
- Source: the lead, after ATLAS REVIEWER's NO BLOCKERS FOUND 7057346617 on #1505 at 153a5bea. DISPLAY, relayed by ATLAS LEAD 11, 2026-11-21.

**An overdue unpaid savings item is treated as spent** · QUEUED (ATLAS LEAD 11, 2026-11-21): DISPLAY's one-liner. Full lane (a figure the household acts on).
- **Why:** under the hold rule, an item dated before the current period is out of the pour as if paid, even when it is overdue and unpaid (not `paymentStatus` `'paid'`). Its money then flows to later goals.
- **Closure:** an overdue unpaid item either keeps its share or is flagged, with a test on an invented overdue item.
- Source: the lead, after ATLAS REVIEWER's NO BLOCKERS FOUND 7057346617 on #1505. DISPLAY, relayed by ATLAS LEAD 11, 2026-11-21.

**A bill's own `dateConfidence` is not served on non-cutover bills (Shaw, Google storage)** · QUEUED (ATLAS LEAD 12, 2026-11-22): from the cautious-tags audit, after #1542 and #1510. Owner: the lead. Full lane (a trust tag on a decision surface).
- **Why:** bill events take a date tag only through `billCutoverDateTrust`, which reads `bill.dateConfidence` only when the bill has a `timingBefore` cutover. A plan bill's own `dateConfidence: "estimated"` is inert. Shaw's 14th and Google storage's month-end are planning dates, but the audit's ask to tag them estimated cannot be met in `data.json` alone.
- **Closure:** Forecast or the live path carries a bill's own `dateConfidence` onto its occurrences (never toward more certainty), then the two rows are tagged. Proof: the served row shows the date as estimated, and a bill with no `dateConfidence` is unchanged.
- Source: independent audit relayed by ATLAS LEAD 12; builder finding on the cautious-tags PR (no inert tags shipped).

**When a TD statement is recorded for a `tdcc-auto17` occurrence, record the fixed autopay as that occurrence's payment** · QUEUED (ATLAS LEAD 11 ruling, 2026-11-21): from #1514's reviewer observation 2. Full lane when a statement is recorded.
- **Why:** a row with a recorded statement plans that statement's minimum. For the TD credit card's fixed automatic payment, the plan would then show the minimum, not the payment actually sent.
- **Closure:** when a statement is recorded on a `tdcc-auto17` occurrence, the fixed autopay is recorded as that occurrence's `sentPayments` entry (intent: fixed autopay), so the plan shows the payment made and the statement minimum stays visible as the floor. If a statement minimum ever exceeds the fixed amount, flag it to the lead for Dale.
- Source: ATLAS REVIEWER 2 on #1514 (7058724201), lead ruling 2026-11-21.

**`/assistant/mcp` spends about 7.8 s of main-thread work after its data read, outside every marked phase** · IN PROGRESS (ATLAS LEAD 12, 2026-11-23): phase marks added (GUARDS). Owner: the lead, for the prod reading. Not on the household page path.
- **Why:** on prod `e5db93db` at 20:39Z, the request's `atlas-timing` line showed unattributed 7792 ms and `mainBusyMs` 7796. The likely cause is the assistant packet build or the MCP encoding, but no phase mark covers that span.
- **Next action:** ~~add phase marks inside the assistant route~~ done: each assistant `atlas-timing` line now carries `assistant: { packetBuild, packetCheck, encode, write }`. Next, one prod call names the 7.8 s; then choose a fix from what it shows.
- Source: the lead, from the #1553/#1558 timing lines.

**`test/browser-observation-memory.js` fails on plain main** · **DONE 2026-11-22** (fixed and registered; GUARDS). Light lane (tests).
- **Why:** a boot-notice overlay (`[data-boot-notice]`) intercepts the test's Cancel click, so the click times out. The suite is not registered in `test/suites.json`, so CI never runs it and nothing catches the failure.
- **Next action:** fix the test or retire it; if it is kept, register it.
- **Resolution:** kept, because no registered suite proves in a real browser that a failed refresh leaves the header inert and hidden until a successful Retry. Its Cancel step now uses the keyboard (Tab to Cancel, then Enter), the only way a household can reach Cancel while loading: by design it takes no pointer input until focused. It is registered as `test/test-browser-observation-memory.js` (renamed, because the `browser-` prefix marks unregistered suites), and it skips where Playwright is absent.
- Source: GUARDS, found while building #1561; the lead added it to the backlog.

**A represented occurrence with an unknown planned amount should price from its posting** · ADDED TO BACKLOG (ATLAS LEAD 12, 2026-11-23, from the #1576 re-review 7091766542). Full lane (figures). Owner: unassigned.
- **Why:** when an obligation occurrence is already represented (its payment is in the opening or a reconciled posting) but its planned amount is unknown, the current pay period's bill load cannot price it, so the native Budget period basis, and the Savings answer that depends on it, are withheld. This fails closed and predates dated schedules: on main, a regular `amount: null` row whose occurrence is in `opening.representedEvents` is also unavailable (through a different incumbent gate). With a dated `amountSchedule` (#1576), the same case now withholds through the period-basis gate, consistent with the unscheduled behaviour.
- **Next action:** design how a represented occurrence's posted amount supplies the bill load when the planned amount is unknown, through the existing settlement path. Keep the planned/actual distinction, and never invent a planned amount.
- Source: the reviewer of record on #1576; dispositioned by the lead.

**Replay retention requires `qualified=true`, so on days Lunch Money hasn't synced every open runs the full provider job** · READY (ATLAS LEAD 12, 2026-11-23): the mechanism question behind OD-031. Owner: the lead.
- **Why:** replay retention requires `qualified=true`, and an unqualified dated result clears retained evidence (`scripts/server-live-refresh.js` `publishResult`, around lines 640–680; `scripts/live-plan.js` `applyForServer`, around line 1953). `stale-live-cash-evidence` is day-based (`assertFreshLivePacket`, around line 308). On a day Lunch Money hasn't synced yet, nothing qualifies, so each open runs the full provider job.
- **Next action:** a desk ruling on OD-031's design (the freshness contract, and any store or qualified-gate question) before any build. OD-030's declined swap stays out.
- Source: ENGINE, relayed by ATLAS LEAD 12.

**Live refresh worker CPU: profiled; three candidates closed, one held** · DISPOSITIONED (ATLAS LEAD 12, 2026-11-23). Do not re-profile these without new evidence. Owner: the lead (held items go to the desk with OD-031).
- **Measured:** `scripts/live-refresh-benchmark.js`, history case (invented data), main `7ff6b144` (after #1564), local wall ms. Primary normalize 296, primary overlay 454 (Forecast 324 inside it), replay check 433 (sourceInputs about 25, replay normalize 264, replay overlay 144). Total about 1.2 s locally; prod runs about 15–20× slower.
- **Replay check off the response path:** DROPPED. The replay check is about 36% of refresh CPU (433 of about 1,183 ms) but sits before serving. Serving early is unsafe because the served `qualified` feeds `completeDisplay` (`publishResult`), the forced-refresh rejection, the `X-Atlas-Observation-Qualified` header (`server.js` data route) and the assistant packet's `sourceCheck`. Revisit only with proof that no post-primary exception can flip `qualified`, or together with the OD-031 cache design.
- **Dedupe the 200-day history read with the transaction window:** REJECTED. The window is 14 days (`CURRENT_STATE_HISTORY_DAYS`) against the history's 200 (`AMOUNT_HISTORY_DAYS`), so only about 7% of the rows overlap. Since #1564 the history read also runs in parallel with the other reads, so the wall-clock saving is near zero.
- **Memoize Forecast within one refresh:** REJECTED, because it is already done. `scripts/operating-answer.js` `createRefreshEvaluation` keeps one deep-equal-keyed result per refresh, and the replay overlay hits it: Forecast runs once per refresh.
- **Single-pass history normalize:** REJECTED as framed. The replay normalize is the verification itself: it re-observes the projected `sourceInputs` to prove the projection reproduces the same data, so its inputs differ by design and memoizing it is invalid. It moves into the OD-031 cache design, where unchanged evidence could skip re-verifying identical inputs (about 400 ms local, roughly 6–8 s prod).
- **Run each sanitizer check once per object per refresh:** HELD for the desk, alongside OD-031. The profile's self-time across both passes is about 280 ms of 1.2 s (about 23%):
  - `sanitizedCurrentPeriodActualsPass` 98, `currentPeriodActualsLooksSanitized` 50, `transactionLooksSanitized` 40, the privacy-field RegExp 39 and `identityProofLooksSanitized` 51;
  - plus `structuredClone` 96 (38 clones) and GC 61.
  The expected saving is about 10–15% of CPU, roughly 2–4 s prod. These are privacy guards, so the work is full lane. Proof needed: every guard still rejects each mutant it rejects today, at every boundary it guards (a mutant matrix test).
- **Classify each transaction once per observe pass:** REJECTED. The 9,640 `classifyCurrentPeriodTransaction` calls per refresh are one per transaction per pass, at `provider-observe.js` `sanitizedCurrentPeriodActualsPass` and `unmatchedHouseholdCash`. The only repeat is across the primary and replay passes, which is the replay verification above. An earlier "2.5× repeat" count was an artifact of the benchmark's copied history rows.
- **One calendar waterfall for the 6 completed pay periods** (`planPastPeriodViews`): REJECTED, built and measured, then not pushed. Advice was byte-identical to main on 75 figures-input evaluations, and each of 1,608 periods equalled its single-window build, including on window boundaries. But one call over all 6 windows costs nearly as much as six one-window calls: that work scales with the date span, not the call count. Forecast went 362 → 348 ms on the history case and 180 → 159 on cards (medians of 5 cold runs), about 0.2–0.4 s prod. That is not worth a full-lane Forecast change.
- **`planDefaultView` and the Forecast memo clones:** not pursued. `planDefaultView` is about 81 ms local, roughly 1.5 s prod, and has the same span-proportional shape, so it is likely the same small gain. The memo clones (`scripts/operating-answer.js` `createRefreshEvaluation`: input snapshot, advice store, advice hit) are about 73 ms local, roughly 1 s prod. Nothing else in Forecast is more than 7% of the stage.
- Source: ENGINE research for ATLAS LEAD 12, 2026-11-23.

**Share the held Other Income set across one `recommend`** · PARKED (ATLAS LEAD 11, 2026-11-19). The lead takes it to the desk as a positive-list design after #1405 lands, because #1405 changes what feeds the hold set. Full lane, Atlas; a missed input publishes a wrong To-confirm hold, so this is a figure-risk change, not a small one.
- **Why:** on the 753-purchase invented harness world (main `311c6c7b`), building the hold set (`computeHeldOtherIncomeKeys` → `calendarIncomeSections`, which scans every packet transaction in its span) is 292 of 1,035 ms inside `recommend`. One `recommend` builds it 36 times. The payday and weekly searches already share it within a search (#980 follow-up, #1406); the other callers do not.
- **Measured (scratch prototype, not a proof):** sharing one holder per outermost `recommend`, matched with the 16 keys below ignored, cuts builds from 36 to 7 on that world (634 to 154 on the 60 invented figures evaluations). Advice was identical on 63 invented cases with 1,020 shared hits. One `recommend` on that world went 101.6 → 79.8 ms (about 21% lower). There was no measurable gain on the invented figures inputs, where the matching overhead eats it. Exact-match sharing alone removes only 7 of 36 builds.
- **The 16 option keys that differ between callers**, each needing its own argument, not just "not read":
  - `horizonDays`, `viewDays`, `viewStart`, `debtHorizonDays`: walk length and view. Show `calendarIncomeSections` takes its span from the hold windows, not from these.
  - `majorPlans`, `plannedDebt`, `extraAbsorbed`, `obligationAbsorbed`: these do add events to the expansion. Show they are never `income` events, which is all the hold set reads.
  - `keepRepresented`: `calendarIncomeSections` sets it to true itself.
  - `sim`, `periodWindows`, `seq`, `budgetHouseholdDaily`: spending-side and walk-side inputs.
  - `s1BillsStockQualifiedCents`, `s1CurrentBillsStockCents`, `s1CurrentBoundaryCreditCents`: savings seed inputs.
- **Proof needed:** a positive list of the inputs that do reach the hold set (plan, start, packet, income overrides, occurrence adjustments, additional income events, disabled ids, and whatever #1405 adds) rather than a longer ignore list. For every other key, a mechanical single-key variation at every captured call, as #1406 did for `weeklyVariable`, plus a code-path trace.
- **Size:** about 25–40 lines in `public/forecast.js` (a holder scoped to the outermost `recommend`, like the income tx-facts memo), and a test of about 300+ lines.
- Source: ENGINE profile for ATLAS LEAD 11, 2026-11-19.

~~A closed period whose bill occurrence has only an unbacked packet entry (no transaction, no settlement basis) still lists it To confirm and counts it, while the current period also carries it (#1156 covers the unrepresented missed occurrence only). Make the closed copy carried after historical settlement qualification (`qualifyHistoricalBillSettlement` / `sealHistoricalBillRow`), not before it. Source: #1156 lead verification, `test-historical-bill-settlement-evidence` H2.~~ Done in `agent/unbacked-closed-bill-carried` (the #1156 rule, on Grok Bot's conditions).
Forecast publishes no native trust tag for the weekly recommendation or for spendable household cash, so the assistant packet carries `unknown` with `trustSource: 'not-tagged-by-Forecast'` for both (finish-line audit finding 12, lead ruling (a)). Give Forecast native tags for those two figures so the page and the packet can both print them. Source: #821 finding 12, lead ruling (b).
~~`Forecast` `planHasMortgagePayment` (#1071) gates the Mortgage-label exclusion on any planned mortgage obligation with a positive amount; tie it to an occurrence of that obligation in the debit's own spending cycle, so an unplanned period's Mortgage row is never excluded. Source: #1071 pre-review observation, lead ruling.~~ Done in `agent/mortgage-exclusion-own-cycle`.

A late-posting bill can be deducted twice in the cash projection until its payment is linked or marked. Example: a mortgage payment that posts in the cycle after its due date is counted once on the Budget (Other spending, to confirm, with the line "Mortgage-labelled; the mortgage due <date> is still To confirm"), while the master cash walk still deducts the unconfirmed earlier occurrence and the debit is already out of the opening. Pre-existing; Atlas does not link the two (no date matching). Ledger-side (rule 17): routed to Grok Bot. Pinned by `test-unplanned-bill-label-counted` ("known limitation"). Source: #1211, Grok Bot via the lead.

~~The linked-bill note's check names are listed three times: the observer (`linkedBillMisfitIds` in `scripts/provider-observe.js`), Forecast (`LINKED_BILL_MISFIT_CHECKS`) and the page (a hard-coded list in `public/plan.js`). A check added to one and not the others is silently dropped. Export Forecast's list and have the page read it (pre-existing; #1267 added two names). Source: #1267 pre-review observation, lead ruling.~~ Done in `agent/linked-bill-misfit-checks-one-home`: the page reads `Forecast.LINKED_BILL_MISFIT_CHECKS`, and `test/test-linked-bill-misfit-check-parity.js` keeps the observer's emitted names equal to it.

~~The bill detail's "Last 6 months" Unavailable reasons have two homes: the observer emits them (`billPaymentHistory` in `scripts/provider-observe.js`) and the page explains them (`HISTORY_REASONS` and a literal per-bill list in `public/bill-detail.js`). A reason added to one and not the other prints a wrong explanation, silently. Source: GUARDS scan, 2026-11-19.~~ Pinned by `test/test-bill-history-reason-parity.js` (agent/bill-history-reason-parity): every observer reason has its own page text, the per-bill list equals the observer's, and every page reason has a producer. No source change; the two still live apart because the observer is server-side.

~~`Forecast.hypotheticalExtraPayment` and `Forecast.hypotheticalExtraPaymentComparison` have no live consumer since Talk was removed (#1048); decide whether to retire them (engine change, full lane). Source: item-8 prune record, #821 comment 6787577449.~~ Retired with their helpers and suites (agent/retire-hypothetical-extra-payment).

Deleting the six legacy pages (2026-11-16) left Forecast functions with no live page consumer. #822 retired `householdBills`, `householdSubscriptions`, `creditAccounts`, `renewal`, `payoffDebts` / `payoffModel` / `paymentForMonths`, `planSpendCards` and `billIsSubscription`, with the helpers only they used, and the tests that called them. `utilisation` and `capitalisingCashMinimumOccurrences` stay (the engine and scripts still use them), and `baselineTrajectory` stays (the assistant packet and the figures snapshot call it); its page-only reprint: `pressure` (with attribution) and `debtDirection` were retired (agent/trajectory-unread-sections); `payPeriods`, `savingsFundingTimeline` and `additionalCashRequired` on the trajectory output stay: no page reads them, but `scripts/assistant-cleanup-effects.js` hashes the whole `baselineTrajectory` result as its metadata-neutrality digest for Lunch Money cleanup edits, so they are read by that digest; keep (lead ruling 2026-11-17). Narrowing that digest is a hard-gate change and a Grok Bot question (rule 17). Also lost with the pages and not re-homed: the printed Credit-card wording ("OVERDUE · TO CONFIRM vs CONFIRMED", and the rendered stock in the qualified vs unqualified credit-date case, both invented fixture values), the Plan spend per-member facts and "Funding requirement" label, the Forecast Road Ahead window and income-total print, and pre-boot focus restoration to a shell control. Source: the delete-switched-off-pages PR card. ~~`.github/labeler.yml` still maps `public/modellers.*` to `evidence-only`; drop that glob when `docs/RISK_LABELS.md` is next touched.~~ Dropped by `agent/labeler-drop-modellers`; `evidence-only` stays a manual category label.

**Clean main view; explanations on tap** · **DONE 2026-11-11** · *PR #1036* (owner direction, Dale, 2026-11-09). #1036 delivered the Savings goals card. Dale withdrew the app-wide extension (#821 comment 6786578829); no other card is in scope. Original item, kept as history: every card in the app should be clean by default, with explanations moved behind a tap that opens a small window. The first target is the Savings goals card. Each row shows only the goal name, a progress bar, and how much is saved against the total needed. The status line, "Still to fund", and the "Estimate: Needed minus Saved… planning gap" sentence move into the tap-to-explain window. The trust contract still holds: a figure that is an estimate keeps a compact marker (for example ≈) on the main view, and its wording is in the window. Do the Savings goals card first, then apply the same pattern app-wide. Dale ranks it below the 1.0 money items. Source: Dale, lead session 2026-11-09.

Provider-observe `firstNumber` turns a blank, `false` or non-numeric raw balance into $0 for any account. This is the root fix (full lane); resume parked #976 on top of it. Source: lead handoff 2026-11-09.

~~The bill detail still lists a cross-period debit as "Possible payment" while Forecast counts it as Other spending. Source: PR #965.~~ Done in 72699a57 (bill-detail reads Forecast's nearDueBillCandidateHeld). Evidence: `candidates()` in `public/bill-detail.js` lists a near-due debit Forecast does not hold as Other spending with its ledger category, never as a possible payment.

~~`test/browser-other-period-target.js` times out (`waitForFunction`, 30 s) on unchanged `main`. Browser suites do not run in hosted CI, so nothing reports it. Find the stale wait and repair the test narrowly, without weakening its checks. Source: PR #1074.~~ Done: it now opens Other spending from the visible ring.

After December 31 of the last payroll-authorised year (2026 when `plan.payrollPlanningAssumptions` is absent), the Budget timeline publishes only the current and next pay periods, no future ones, and `horizonReason` says the owner minimum (next plus 8 future) is not met (#962 C5, confirmed 2026-11-16). This is the designed fail-closed stop in `payPeriodTimelineBound`, already pinned by `test-budget-timeline-pay-periods.js`. Whether to change it is a design decision (for example, showing later periods with income Unknown); authorising a later payroll year is an owner input. Reproduction, invented data: take `timelinePlan(asOf)` and `recommend` from `test/test-budget-timeline-pay-periods.js`, delete `plan.payrollPlanningAssumptions`, and run at as-of 2026-11-20, 2027-01-10 and 2028-02-10. `payPeriodViews` timeline roles are past 6 / current 1 / next 1 / future 1, then past 6 / current 1 / next 1 twice, with `payPeriodTimeline.through` 2026-12-31 each time. Source: #962 C5; probe by the GUARDS builder, 2026-11-16.

~~`firstDue` card-minimum stubs print the opening-row label but are not deducted. Source: PR #977 pre-review.~~ Done in `agent/drop-firstdue-minimum-stub`: the stub row is no longer listed, so the printed period total equals the deduction.

~~A future-dated one-off settled by a #927 credit is still carried in the forward walk (pre-existing on main). Source: PR #857.~~ Done in `agent/walk-follows-credit-settled-income`, on Grok Bot's four conditions.

~~Add an inside-opening case to `test-bill-payment-excess`. Source: PR #920.~~ Done: the inside-opening case is in `test/test-bill-payment-excess.js`.

~~A stronger end-to-end HTTP test for Talk follow-ups. Source: PR #890.~~ Retired 2026-11-11 with Talk (B103).

~~The automated pre-review `post` job withholds a valid record when the model's text uses PASS / APPROVE vocabulary, for example when quoting test names. Narrow the filter so it does not misfire, without weakening it. Source: PR #1002 (head 34bde21).~~ Fixed by `agent/pre-review-disclaimer-filter`.

**Due before 2026-12-02, not after 1.0:** GitHub's new default event policy blocks `pull_request_target` in public repositories. It is enforced from 2026-12-02, with scheduled brownouts before then; one blocked every PR from about 14:00 to 18:00 UTC on 2026-11-09. `privacy-guard.yml` and `risk-label-gate.yml` depend on that trigger, so a repository Actions event policy that explicitly allows it is needed. That is an owner settings action (stop 4), asked in the Plan #6 thread on 2026-11-09. Startup-failure runs cannot be re-run; only a new push or a reopen re-triggers them. Source: run 42660316051 annotation; https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target.

~~A zero regular-payroll override hides an already-received payroll row in the Budget/default view. Display only; received cash is correct. Pre-existing. Source: PR #921 (observation 13).~~ Struck 2026-11-16 (STALE-SUPERSEDED): no page control can set it. The only income-override inputs are for streams with `scenarioMonthly`, and no plan stream has one; the zero override that `incomeDeadline` passes stays inside its own walk and prints no Budget rows.

~~Netting refunds into Other spending understates it (G3a kept as a recorded limitation). Source: PR #927.~~ Done (LEDGER A item 3, option A): only a ledger-linked refund (a Lunch Money group parent) nets; a standalone refund is listed as Refunds not linked.

`spendPublication.historicalActuals` still publishes `'recent-two-period-baseline'`, and two comments in `public/forecast.js` still say "two-period", although Road Ahead normal spending now averages up to six covered closed pay periods plus the current-period estimate (#1307). Rename the machine label once every reader of it is checked (it may be keyed on by a page, the packet or a snapshot), and fix the comments. Source: #1307 independent pre-review, non-blocking.

`Forecast.lookbackActualsCoverageState` checks the start of coverage only when the packet carries `coverageStart`, so a packet without one reads as covering all history. #1307 guards its own older closed periods against this; the newest closed period of normal spending and the past-period picker still take the shared predicate as is (pre-existing on main; the live observer always sets `coverageStart`). Make a missing `coverageStart` incomplete in the shared predicate (engine change, full lane), with a test per caller. Source: #1307 independent pre-review.

NEXT PR (LEDGER A item 3, option B): link a refund to its purchase through Lunch Money transaction groups. Fetch with `include_children=true` (GET only), allow and read `group_parent_id`, link only when a group holds exactly one refund and its purchase, both posted (Grok Bot's conditions), never count the group parent alongside its children, and revert a removed group to unlinked. Grok Bot notes that the read-only assistant Lunch Money transaction tool already reports "group children included, group parents excluded": check how `scripts/assistant-lunchmoney.js` asks before writing a new fetch. Needs a private check of a live grouped pair's shape (children carry `group_parent_id`; the parent's amount and category) by Dale and Grok before it is built. Source: lead 2026-11-16.

~~"Future receipts in this period" still lists a planned one-off that has already arrived. Source: PR #927.~~ Fixed: the from-today walk no longer replays an occurrence already in cash (agent/future-receipts-skip-arrived).

Card inference can use a future-dated posted card balance (diagnostic only). Source: PR #924.

**A flaky required check cannot be diagnosed from public CI** · *GUARDS, 2026-11-19, from the F9 merge-queue flake; owner: lead; needs a design decision*
Public CI records only each failed suite's identity and its `failedSubtests` names (`scripts/ci-output.js`). It never reads or prints assertion messages, values or stacks, on purpose: the repository is public and a message can carry a figure. That privacy rule stays. The cost is that a one-off failure leaves no evidence: the F9 flake was only diagnosed by reproducing it under a local stress loop. Next action: decide whether a failing suite's diagnostics can reach the builder privately (for example a non-public artifact or a sanitized assertion location such as file and line only), without weakening `ci-output.js`'s public rule. Any route that moves raw test output off the runner is an owner question (stop 3) and needs the same private transport the suspended automatic repair lacks.

~~**The bill detail's Visa payment reasons disagree with the card ledger** · *GUARDS scan, 2026-11-19; owner: the card-ledger path holder, after the current card work lands*~~ · **DONE 2026-11-19 (LEDGER A).**
Corrected on the card-ledger read (main 36544f27). `public/bill-detail.js` `VISA_REASONS` had **nine** keys nothing produced, not seven: `incomplete-evidence`, `ambiguous-credit`, `missing-amount`, `missing-date`, `missing-account`, `contradictory-account`, `missing-identity`, plus `pending-possible-replacement` and `pending-settlement-ambiguous`, which exist only in the pending-card failure reader, which publishes its own text. The conflict codes (`coverage-allocation-conflict`, `coverage-identity-ambiguous`, `coverage-reversal-allocation-conflict`, `coverage-reversal-unconfirmed` and the dynamic `problem.code`) never reach the page. They are written only into `paymentAllocations` on the diagnostic pass (`paymentDiagnostics: true`), which only the settlement qualifier reads. The published payment rows carry one reason, `payment-intent-unconfirmed`, or none when reconciled. Fixed: `Forecast.CARD_PAYMENT_REASONS` is the card ledger's closed set, with the one line the page prints for each reason. `visaPaymentPublication` publishes any other reason as the fail-closed `payment-reason-unavailable`, and `VISA_REASONS` is removed. Proof: `test/test-card-payment-reasons-closed-set.js` (two-way parity through the served path, including the diagnostic codes and dynamic or hostile values). Publishing the qualifier's conflict codes to the page stays out of scope.

Settlement-evidence relief with no transaction rows gets no E row. ATLAS-080-adjacent; stays frozen with ATLAS-080. Source: PR #930.

~~The between-paydays operating renderer shows a pending row as "Status unresolved". Revisit the cutover assumption if provider balances turn out to exclude pending debits. Source: PR #907.~~ Struck 2026-11-16 (STALE-SUPERSEDED): `betweenPaydaysOperatingHtml` (public/plan.js) has no caller on any page; only tests call it. Retiring the renderer itself is dead-code work for the lead to route.

~~Talk maps null, empty or unknown confidence to calculated, and the covered answer hard-codes calculated. Fix with one shared weakest-trust helper for every Talk answer branch (named NEXT PR on #907). Source: PR #907.~~ Retired 2026-11-11 with Talk (B103).

~~A captured closed pay period keeps only a bill row's `date` (the period-history projection does not carry `scheduledDue`). A once row that stands in for a skipped recurring occurrence, captured after the #887 rebuild, therefore prints its real occurrence date in that closed view, not its scheduled due. Display only; no figure differs. Source: the #887 rebuild (`agent/one-off-bill-period`).~~ Fixed: the saved close borrows the printed due from today's row for the same occurrence (agent/closed-period-scheduled-due).

~~`billIsOccurrenceStub` leaves any once bill whose id extends a recurring bill's id off the Bills and Subscriptions page rosters, whether or not it stands in for a skipped occurrence. It is the same id-prefix guess #1037 demoted to a printed label on the Budget page; no pay-period figure reads it. Source: PR #1037 review.~~ Struck 2026-11-16 (STALE-SUPERSEDED): the Bills and Subscriptions pages and `billIsOccurrenceStub` no longer exist.

An unknown-pending card is in flight in #951 (the #926 NEXT PR). Still open after it: headroom / "credit left" counts that card's room as 0, and per-card mark balances still use posted plus retained pending. Source: PRs #926, #951.

~~`test/browser/*.cjs` is not covered by the #904 browser-suite classification; owned by the #904 follow-up. Source: PR #904.~~ Superseded: #904 closed unmerged, so there is no classification to extend (lead, 2026-11-16).

~~When #904 lands, the browser suite split out of #930's savings suite (`test/browser-savings-dated-balance-item-liability.js`) needs a RUN/NOT_RUN entry. Source: PRs #904, #930.~~ Superseded: #904 closed unmerged (lead, 2026-11-16).

~~Find other registered node suites that `require('playwright')` through the harness (#930's suite never passed hosted CI; #870 had the same issue), and consider a static check that registered suites do not reach playwright. Source: PRs #930, #870.~~ Done: none on main reaches it unguarded; `test/test-suites-playwright-reach.js` now fails any that does.

~~The legacy calendar sentence "excluding bills already settled in the opening" (`public/plan.js`, period bills note) goes stale after #923; follow-up PR after #923 merges. Source: PR #923.~~ Struck 2026-11-16 (ALREADY FIXED): the sentence is no longer in `public/plan.js`, and `test-bad-full-period-bill-load.js` asserts it stays absent.

~~`scripts/positions-summary.js` sums debt balances and annual interest with `|| 0`, so a missing value counts as zero (`docs/positions.csv` only). Source: PR #901.~~ Fixed by `agent/positions-unknown-debt`.

~~The Deep Dive interest note prints `money(null)` when mortgage interest is missing. Source: PR #901.~~ Struck 2026-11-16 (STALE-SUPERSEDED): the Deep Dive page was removed (#822 slice 4, bc8aae3).

~~`scripts/reconcile.js` checks `settledOn` for date shape only, so an impossible calendar date passes there; #934 (A8) makes the Forecast side strict. Source: builder findings 2026-11-08, adjacent to PR #934.~~ Fixed by `agent/reconcile-calendar-dates`.

~~`majorPlans` should withhold when card coverage is unknown. Source: builder findings 2026-11-08 (no PR yet).~~ Already fixed: 29b06744 withholds every future-cost verdict, margin and remaining amount when card coverage is unavailable, and b069242d names the reason. `test/test-major-plans-card-coverage-unknown.js` (registered) pins it on invented data, with a known-coverage control. Dropping the coverage condition fails 9 of its checks.

"Total bills this period" needs an estimated marker when its load includes estimates. Source: builder findings 2026-11-08 (no PR yet). **Owner decision:** it adds a new visible ≈ mark, and Dale asked for no new ≈ marks without his OK (lead, 2026-11-16); not built until he says so.

~~A future period's bills total versus a null (unknown) bill load: the total should not print a known figure over an unknown load. Source: builder findings 2026-11-08 (no PR yet).~~ Done: #1170 (open periods) and #1248 (closed periods): an unknown load leaves the total and load Unknown in every period. An open period's remainder is Unknown too; a closed period's remainder stays 0 as settlement evidence (#931), with the unknown carried by its unconfirmed bills, and its after-bills figures read Unknown.

The GitHub merge queue needs an organization-owned public repository or Enterprise for a private one; revisit only if the repository moves to an organization. Source: lead's findings 2026-11-08.

**`data.json` keys with no reader** · *owner decision*
The Deep Dive and Records pages were removed under #822. They were the only
readers of 18 `data.json` keys: `upcomingNote`, `debtsNote`, `utilisationNote`,
`assetsNote`, `netWorth`, `helocSummary`, `helocUse`, `helocUseNote`,
`helocChains`, `cashflow`, `cashflowNote`, `incomeWarning`, `incomeNote`,
`spendingNote`, `counterparties`, `coachPayment`, `unexplained` and `questions`.
`interestCheck` joined them when #822 slice 10 retired `Forecast.deepDive`, its
only reader.
No page, script or the assistant packet reads them now, but `/data.json` still
serves them to a signed-in browser. `test-invariants.js` pins the exact list.
Decide whether to delete them from `data.json` (and stop producing them) or
keep them as a record. `test-question-status.js` still checks
`data.json.questions` against `docs/01_OPEN_QUESTIONS.md`.

~~**Precondition for #822 slice 10: the snapshot still calls `Forecast.deepDive`** · *small*~~ Done 2026-11-18: `heloc.currentOpening` is dropped from the snapshot. Its only publisher was the removed Deep Dive page, and the same posted HELOC opening stays observed as `revolving.heloc.posted` (`Forecast.utilisation`) and `scoreboard.today.heloc`. `test-figures-snapshot-credit-planning` section 6 asserts the snapshot calls `deepDive` 0 times. Outside dead-page code and its own tests, nothing now calls `deepDive`; deleting it is slice 10. The original entry:
`scripts/figures-snapshot.js` reads `heloc.currentOpening` from
`Forecast.deepDive(data)` and `balance.assets` from
`Forecast.publicationTotals(data)`. Slice 10 removes the dead-page exports
from `forecast.js`; `deepDive` cannot go until `heloc.currentOpening` is
re-sourced from a function that stays, or dropped from the snapshot. Either
is a figures-tooling change (full lane, Atlas). Source: #822 slice 8 scoping,
2026-11-11.

~~**Engine helpers no figures-check input observes** · *small*~~ Closed 2026-11-18. Re-probed on main `4a215db6`: all six still moved 0 compared keys. Three were reached by no input; a new invented input, `test/fixtures/figures-inputs/scheduled-bill-price.json`, now reaches them. Planted alone on that input, `billIsHouseholdObligation` ignoring `false` moves 66 keys, `billOccurrenceAmount` +1 on a regular amount 23, and the promoted term confidence 5 (the trust tags). The other three cannot move a compared key from any invented input. `carriedPastDue` and `dueOnOrAfter` are read only by `nextDue` / `nextPaymentOut`, which feed the Plan page's next-cash-out tile, the payday coming-up rows and the assistant packet: page-side, outside the compared fields. `billScheduleBlocksNormalization` is read only by `budgetBreakdown`, which needs a spending-history payload, and every invented input declares `absent-periods`. Each of the three stays guarded by registered suites that fail when it is planted: `test-next-due`, `test-next-payment-out` and `test-overdue-next-payment` for the first two, and `test-bill-amount-schedule` for the third. The original entry:
A mutation probe run for #1108 planted one defect at a time in `public/forecast.js`
and counted the check-snapshot keys that moved, on the household dated opening
and all 11 invented inputs. Six defects moved 0 keys at #1108's base, so
none is caused by it: `carriedPastDue` never true; `dueOnOrAfter` excluding
as-of itself; `billIsHouseholdObligation` ignoring `householdObligation: false`;
`billOccurrenceAmount` off by one on a regular amount; a promotional term's
`estimated` confidence promoted; and `billScheduleBlocksNormalization` never
blocking. Either no input exercises the branch or no compared key reads it.
For each: add an invented input that reaches it, or record why no published
figure depends on it. Source: #1108 repair, 2026-11-11.

~~**Dead-code cleanup of the retired repair identities in `ci-output.js`** · *small* The retired repair/review-sync scripts and their tests were removed under #822. What remains is the `ci-output.js` identities `codex-review-gate` and `atlas-test-repair-gate` (and their exit-78 mapping), which no workflow uses. `ci-output.js` is the live CI privacy relay, so removing them is its own change. Not urgent: nothing runs them.~~ Done in `agent/ci-output-retired-identities`: both identities, their exit-78 mapping and the `private-artifact-blocked` category removed from `ci-output.js`; every live identity's public record and exit code unchanged.

~~Coverage rule 3 hard-codes the Bills account id `chequing-a`. Source: [PR #850 comment 6688280401](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/850#issuecomment-6688280401).~~ Struck 2026-11-18 (lead ruling): still true, and correct. `chequing-a` is the canonical Bills identity, the same one `REQUIRED_LIVE_CASH_IDS`, the salary attribution and the plan's cash rows use. The account map carries no second Bills marker to derive it from, and a rename fails closed: the stamp reads incomplete and figures withhold.

An Other income credit near payday stays "to confirm" after the payday is proven. Finding 1's hold (`possible-scheduled-income-receipt`) holds an income credit within 3 days of a scheduled payday no identity has proven, when it reaches half the paycheque: it adds $0 and the paycheque stays counted at plan. The hold never releases. With invented data (credit three days before payday, paycheque posted and identity-matched on payday), the credit is still held a day after payday; suspected cause, not confirmed: the completed window proves the hold against its own packet, which ends before the payday. A same-amount transfer to savings does not change it. Releasing the hold is safe only when the credit stays in household cash: when the owner moves it on to savings (tenant rent, OD-024), the onward Bills-to-savings transfer is an internal move that deducts nothing, so releasing it into Other income would overstate Balance After Deductions; today's $0 hold is the cautious result for that pattern (lead ruling 2026-11-18). Open question: how to tell the two cases apart without Atlas-side matching (rule 17). Source: rent check 2026-11-18 (#821 6978494592); verification and lead ruling 2026-11-18.

A future period-history runner should treat `history-original-or-closing-conflict` as a retryable duplicate. Source: [PR #831 comment 6689055764](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/831#issuecomment-6689055764).

A pending row plus two posted copies of the same id picks `posted[0]` silently. Source: [PR #852 comment 6691030123](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/852#issuecomment-6691030123).

Two pending-only copies of one id count twice in pending gravity (conservative). Source: [PR #852 comment 6691030123](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/852#issuecomment-6691030123).

Consumers that read packet rows without the coverage gate are unchanged from main and may still double count duplicates. Source: [PR #852 card](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/852).

A Savings-paid non-item household purchase stays in the household hold (conservative). Source: [PR #851 card](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/851).

The period-history engine-commit fallback to `RENDER_GIT_COMMIT` applies on any `git rev-parse` failure (no git binary, dubious ownership, corrupt checkout), not only a missing `.git`; the engine-file dirty check is then skipped, though `filesFingerprint` still records what ran. Source: [PR #861 comment 6699577646](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/861#issuecomment-6699577646).

~~The capture-on-refresh worker is not unref'd, so an in-flight capture can hold server shutdown for up to its bounds (120 s). Source: [PR #861 comment 6699577646](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/861#issuecomment-6699577646).~~ Done 2026-11-18 (agent/capture-worker-unref): the owner unrefs the worker after attaching its listeners; `test/test-period-history-refresh-capture.js` C9 proves a real process exits while a capture is in flight.

The period-history projection holds no savings pool, savings-goal or held-balance fields, so a captured close cannot show its savings balance (it shows Unknown). Source: [PR #861 card](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/861).

A completed period's historical packet still carries `stock.reportedStock` with today's reported amount. It comes from the `...savingsFunding.stock` spread, which predates #864. Nothing renders it for a past period today: `savings-inventory.js` gates `reportedKnown` on a current packet, and the `plan.js` compact stock is date-gated. A future consumer reading `packet.stock.reportedStock` on a historical packet would leak it; withholding it there too would close the class. Source: [PR #864 comment 6702067980](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/864#issuecomment-6702067980).

Owner-stated wording is needed before `opts.savingsConfirmations` (owner cents / future-dated confirmation) is wired into a live path. Source: #870 note 1.

Move Node 20 to pinned 24 in the figures workflow, `privacy-guard.yml` and `figures-review.yml`. `figures-review.yml` is pinned machinery and needs a reviewed re-pin.

Current Balance confirmation must come from positive provider evidence, not from a missing confidence tag.

The cookie Secure flag trusts the client's `x-forwarded-proto`. Owner-reserved stop 4 (Dale).

Session revocation, and rate limits on refresh and login (`/talk/ask` was removed 2026-11-11). Owner-reserved stop 4 (Dale).

Move the packet sanitizer to an allowlist (M10).

Scenario-baseline settlement evidence (A5).

Figures-check conclusion on change / incomplete (M7).

ATLAS-080 custody column UPDATE (A15). ATLAS-080 stays frozen.

`positions-summary` stale rows and the LTV claim (A21).

~~`calendar-ics` business days (A22).~~ Property-tax reminder fixed by `agent/property-tax-business-day`; card statement days are unchanged (bank weekend rules are a household fact).

Offline utilities and latent helpers cleanup.

~~Negative card balance interest (A7).~~ Already fixed by #966: the forecast walk accrues borrower interest only on money owed (`Math.max(0, balance)`); `test/test-card-credit-balance-no-interest.js`.

~~Hidden-page-only defects: delete the legacy page code after 1.0.~~ Struck 2026-11-16 (ALREADY FIXED): the six legacy pages were deleted on 2026-11-16.

Merchant names in the test suites: revisit with the repo-private decision.

~~Privacy guard scans the net diff only, and ignores symlink targets. Security; next PR after 1.0.~~ Fixed by `agent/privacy-guard-every-commit`.

~~Card-to-card refunds are not exercised in the harness, and there is no label for `refund-unlinked`. Source: #880 follow-up.~~ Done: the label reads "Refund not linked", and the harness exercises same-card and other-card refunds (Grok Bot, rule 17). Reserving a pending look-alike charge is not built: pending never counts.

If #road-ahead is ever shown again: first give its forward-walk mounts a withheld path on sim.cardPurchaseCoverage unavailable/estimated (reuse renderPlanSettlementUnavailable). Today `#plan-window`, `#c-forecast`, `#hero-ledger`, `#wk-table`, `#wk-cards`, `#cal-months` and `#cal-agenda` print the raw forward walk even when card coverage is withheld; they are safe only because the section ships `hidden inert aria-hidden="true"`, which `test/test-operating-surface.js` pins. Source: GUARDS on #1358; lead ruling (B) 2026-11-18.

If #payday-answer (the current-period worksheet, `paydayAnswerHtml` in `public/plan.js`) is ever shown again, first make every figure it prints carry its own Forecast trust tag. Today these print without it: (1) "Money available" (`paydayAllocation.available`), which ignores `paydayShellTrust.available`; (3) "Bills currently reserved", its shortfall and the required total (`obligations.allocated`, `shortfall`, `wanted`), which ignore `paydayShellTrust.obligations`; (5) `essMoney`, covering "Required for period", "Cash available for essentials" and "Essential shortfall", which reads `essentials.trust` only (a carried Lunch Money budget) and misses `paydayShellTrust.household` (estimated with an estimated available; unknown when coverage is lost); (6) the weekly permission (`recommended`), "What else this paycheque funds" rows, "Coming before next payday" rows and the Funding-risk gaps, whose sources are not yet traced; and, between paydays, "Already done" (`r.planned`) and "Verify" (`r.remaining`), which ignore `r.confidence`, plus the category, posted and `essentialRemaining` figures, not yet traced. The bill rows and essential rows are already tagged. Today the card is safe only because the section ships `hidden inert aria-hidden="true"` and no script unhides it, which `test/test-payday-answer-stays-hidden.js` pins on the markup and on the real page at 1280 and 390. Source: the payday-answer trust sweep; lead ruling (A) 2026-11-19.

**Owner decision (Dale):** the savings pools inventory (assigned to goals, backed, unallocated) is only in the legacy "Savings accounts & evidence" disclosure. The Budget face clips that off-screen, so nobody can see it, and it is no longer a Tab stop. Show it on the face, or retire it? Source: TESTS triage 2026-11-16, lead answer H.

The Budget attention list was raised as the same case; resolved by the Other-ring flag (#1348). The face keeps that list off-screen by design and shows each item on the face: a bill to confirm on its bill row, and Other spending's "needs a category" as a badge on the Other ring. `test/browser-budget-attention-order.js` (not in `suites.json`) now follows the offstage list and proves the pointer path on the Other ring (#1347). Source: lead, 2026-11-18, from UNKNOWN's browser triage on main 1530281f.

~~**HIGH priority — triage right after the current wave:** 18 browser suites fail on assertions and 19 time out. Source: #904 follow-up.~~ Done 2026-11-18. Re-run on main `1530281f` with `CHROME_PATH=/opt/pw-browsers/chromium` and `ATLAS_RELEASE_ENGINE=chromium`: 20 of 116 browser suites failed and none timed out.
- 12 are the setup-only suites listed below, unchanged.
- 7 were stale and are repaired or retired, one PR per root cause:
  - #1342, three refund suites: the ledger-linked refund form #1234 nets;
  - #1346, `browser-unknown-chequing-opening-budget` and `browser-bills-opening-source-transition`: #1312's estimated later periods;
  - #1347, `browser-budget-attention-order`: the footer was removed, and the attention list is offstage by design;
  - #1350, `browser-planned-savings-clarity` retired, its uncovered claims ported to `browser-savings-stock-pending`.
- 1, `browser-household-panel-viewport`, was load-sensitive and passes alone.

No page defect was found; the one candidate (a bill attention item) has its face equivalent in the Bills header count, per the lead.

Triaged 2026-11-16 (TESTS builder): 38 of 114 browser suites failed on main `cae7b811`. Stale suites are repaired or retired one PR per root cause; page defects found on the way go to the lead. These need setup, not repair:

- `browser-app-release-resume`: WebKit. With Chromium only, set `ATLAS_RELEASE_ENGINE=chromium`.
- `browser-a9-expanded-panel-visibility` and `browser-a9-future-period-retirement`: the settlement Postgres guard refuses a process with `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE` set. Unset them (no database is needed).
- `browser-a9-unknown-operation`: a settlement Postgres environment.
- `browser-card-purchase-coverage` and `browser-payday-bank-eod-anchor`: a local DevTools endpoint.
- `browser-payday-gap-cash-identity`: `ATLAS_GAP_BASE_APP_ROOT` naming a frozen base checkout.
- `browser-budget-blend-proof`, `browser-budget-signed-cents`, `browser-river-geometry-proof`, `browser-savings-latest-known-allocation`, `browser-budget-river-readability`: a clean checkout and an evidence directory outside it. A `node_modules` symlink makes the checkout dirty, because `.gitignore`'s `node_modules/` does not match a symlink.
- ~~`browser-tile-separation`: a one-off proof generator. It needs `--label before|after` and overwrites `docs/proof/tile-separation-2026-10-10/`.~~ Retired 2026-11-20 with `browser-household-total-delta`: both were one-off before/after proofs pinned to old baselines (a 2026-10-10 tile capture; base `c1d8c155`), so their result could change no decision. Their evidence stays in `docs/proof/tile-separation-2026-10-10/` and `test/proofs/household-total-delta/`.

`browser-household-panel-viewport` passes on main (939/939); its earlier failure was load-sensitive (again on 2026-11-18: it fails with three suites at once and passes alone).

~~Talk says only "due today" for overdue items. Source: #883 follow-up.~~ Retired 2026-11-11 with Talk (B103).

~~Transitive npm advisories. Source: #900 follow-up.~~ Cleared by `agent/npm-audit-transitive` (hono and @hono/node-server patch bumps; `npm audit` reports 0).

~~`operating-answer.js` loads the real `periods.json` in synthetic fixtures. Source: #897 follow-up.~~ Closed 2026-11-18 (lead ruling). The acceptance harness, the invented-world path, reads the file as absent since 205da705, guarded by `test-acceptance-harness-hermetic-periods`. With the file forced absent, 17 of the 20 older direct suites that reach `loadPeriods` give the same results, including every invented-data suite. The other 3 use it by design: `test-live-plan` and `test-refresh-05-operating-answer` run on the committed household opening, and `test-refresh-evaluation-reuse` tests that periods are loaded. The file is the committed, sanitised aggregate `ARCHITECTURE.md` names as the home for actuals, so reading it in a test publishes nothing new.

~~Recurring-audit `standingRuleFor` wording. Source: #902 follow-up.~~ Stale: `scripts/recurring-audit.js` was removed 2026-11-17.

~~An uncategorised store-rule row at a zero target is not counted, and an invisible-category refund is not netted. Source: #902 follow-up.~~ Closed 2026-11-18. The refund half is LEDGER A item 3: a refund in a hidden category stays hidden with its category, per Grok Bot. The zero-target half is STALE: on main `df873fbc` the row counts once as spending in the store rule's category (or Other spending with no category row), and Balance After Deductions falls by its amount. `test/test-store-rule-zero-target.js` pins it.

~~Reserve the pending look-alike as an estimated deduction. Source: #881 follow-up.~~ Retired: Grok Bot (rule 17, LEDGER A) declined it because pending never counts. A hint is fine.

~~Closed trust vocabulary for `talkAnswerMetaText`. Source: #896 follow-up.~~ Struck 2026-11-16 (STALE-SUPERSEDED): Talk was retired (B103); `talkAnswerMetaText` no longer exists.

~~Sub-cent float noise below zero is still marked "negative". Source: #914 follow-up.~~ Done: #914 moved the overdraft flags to `below(x, 0)`; the opening gap date and the forecast chart caption followed in `agent/overdraft-date-half-cent`.

~~Dated-mode NULL-opening trust tags (non-visible); watch `post-balance-activity-unrepresented`. Source: #919 follow-up.~~ Stale 2026-11-16: #919 closed unmerged, so main has no dated-latest-sync mode and no `post-balance-activity-unrepresented` reason to watch.

~~Hidden page shows "Unknown" beside a VERIFIED chip. Source: #893 follow-up.~~ Struck 2026-11-16 (STALE-SUPERSEDED): the hidden pages (Records, Credit, Deep Dive, Planning) were deleted.

~~Stale `test/browser-savings-future-closing.js`. Source: #908 follow-up.~~ Already fixed: #1121 repaired it, and it passes on main `cae7b811` (all 14 modes at 3 widths).

~~Seed the #1162 replay-reuse slot from the qualified live result, so the first replay after a live refresh also skips compute. Source: #1162 Additional findings.~~ Not built (lead ruling 2026-11-16): the live worker records no disk witness and its check differs from a replay's, so seeding needs a second recorder path and a hand-built replay-shaped check on the page-load publication path, for a gain of one Forecast run per live refresh.

~~`test/road-ahead-mutation-check.js` fails on unchanged `main` (found 2026-11-16 while pruning baselineTrajectory). Repair it narrowly or record why it is retired. Source: #1198 card.~~ Repaired 2026-11-18: the eighth mutant's pattern still matched the code shape before 4f1cee1a, so it no longer applied. It now targets the current per-day category split, and all eight mutants are caught on main.

**Declined for now by the owner** (Dale, 2026-11-16, recorded on #821). Not to be built unless Dale reopens them:
- A Bank-check line on the Budget page (Forecast already publishes `bankCheck` on the current pay-period row; the page keeps not showing it).
- Approximate (≈) marks on trusted totals.
- Showing the hidden Savings accounts inventory.

**Open issues parked until after 1.0** (lead issue sweep, 2026-11-11). None is a #821 item 1–7 blocker; each keeps its own holds as written on the issue.

- #768: recurring-bill planned-input corrections. A durable, removable correction to a recurring bill's planned amount or date, which Forecast uses for future periods. It never rewrites history or edits a Lunch Money transaction.
- #749 (ATLAS-081): connect Amanda's read-only Atlas MCP. Confirm the OAuth exchange and one authorized current-state read before calling it complete. The scope stays `atlas.current.read`.
- #748 (ATLAS-043): narrow recurring categorization rules. Device acceptance of the coffee-only alias. No blanket mapping, provider rule or provider write.
- #747 (ATLAS-037): show transfers that still need review. Verify incomplete-coverage withholding and device usability of the released read-only views.
- #744 (ATLAS-052): match the two Amazon purchases to posted charges from shipment evidence. Ambiguous matches stay unresolved, with no provider correction.
- #741 (ATLAS-054): open mobile Household panels in the current viewport. Reproduce on a real device before any repair.
- #732 (ATLAS-032): apply the rehearsal and Fortis input decisions. Verify the existing rehearsal timing and do not reimplement it. Persistent planned-input changes depend on ATLAS-080.
- #729 (ATLAS-049): finish account coverage and monthly reconciliation, limited to the evidence a release needs. Do not invent missing history.
- #721 (ATLAS-080, save private planned-cost corrections) is the frozen ATLAS-080 foundation, together with the items that depend on it (#732's persistent inputs, and the ATLAS-080-adjacent settlement-relief line above). It is owner-reserved and untouched: nothing here starts, scopes or unfreezes it.

---

~~Partly-paid for scheduled fees (the two-account settled-fee path, `tdfees`): a settled fee that is posted but below its allowance. The existing path stays exactly as on main (only the fees it already covers, only posted linked fee rows count, pending stays separate, no name or amount matching). Design goes to Grok Bot first. Source: partly-paid bills build, lead 2026-11-15 (Grok rule 17 answer, bill-payment confirmation).~~ Done (LEDGER A item 1, labels only).

"Payment pending" for scheduled fees (`tdfees`): main's pending link skips the two-leg fee rules, so a pending fee reads To confirm, never Payment pending (it does not count either way). Building it is new linking in the observer; its design goes back to Grok Bot first (Grok agreed to defer it). Source: LEDGER A item 1, lead 2026-11-16.

New bill-linking mechanisms from Grok's rule 4 (a payment links to a bill only by recurring link, item note or single-bill category, no name or amount matching): main links bills through the existing identity rules (37 of 46 use a payee pattern, 13 use an amount gate, one uses a Lunch Money recurring id; there is no item-note or single-bill-category linking). Building those mechanisms, or restricting the payee/amount rules, is new matching logic with its own design and review with Grok; the partly-paid PR adds none. Source: partly-paid bills build, lead 2026-11-15.

## Done

**The 9 August analysis run — five items, all published to the site.**

- **B61 · E-transfer counterparties** — 24 → 49 of 204. Follow-up is **B66**.
- **B31 · Multi-hop chains** — premise disproved; B64 cannot be solved from transfer data.
- **B34 · Merchant library** — chequing uncategorised 12.0% → 4.5%.
- **B7 · The $158.55 interest charge** — explained as average-daily-balance retail interest, not a cash advance.
- **B62 · Youth lacrosse** — floor $5,143.56 → $5,729.47; 40% paid from the HELOC.

The 30 June coaching remittance was re-traced and a coach was paid out of it — $2,160.00 on 6 July. See B63.

**Capture — complete.** Every consumer debt in the household is captured.

- **B45** `raw/` backed up to OneDrive, verified, with a SHA-256 manifest
- **B1** `data.json` and `positions.csv` brought current
- **B10 / B36 / B46** MBNA = the Amazon Mastercard, one card not two. 21.74%,
  all 8 statements as PDF and CSV
- **B2 / B3 / B4 / B4b / B6** Both TD cards at 12 of 12 statements; Travel Visa
  limit $1,100
- **B48 / B50** Wise ×2 captured; the road trip totalled at ≈C$6,645
- **B55 / B55b** Coaching workbooks parsed — coaches take **27.7%**. The books
  cover late Apr–Aug 2026, so the share is extrapolated from ~4 months
- **B54** Card spending categorised — **$44,344.58**, 65% discretionary
- **B34** Merchant library seeded — 273 patterns
- **B17** Payoff ranking settled; net worth **$357k–$657k**
- **B18** The **$46,657** payment-matching investigation completed — captured cards received more than the labelled TFR-TO C/C transfers in the 12-month window. Destination evidence only; owner closed Q2 2026-08-29 in `docs/01_OPEN_QUESTIONS.md` (three TD credit cards; not a missing fourth TD Visa; June HELOC TFR-TO C/C lines still lack per-card destinations)
- **B52** The $10,000 Ivoclar charge — a funded pass-through, not household money
- **B53** `Head Canada` — a coaching business expense Amanda absorbs
- **B12** Home valued at $1.1m–$1.4m [ESTIMATE]
- **B37 / B11** Amex closed; Flexiti closed (owner 2026-08-31); Affirm has one
  final $32.53 payment due 2026-09-21, then no recurrence. Do not combine Affirm
  and Flexiti.
- **B5 / B35 / B41 / B33** Earlier verifications

---

## The three biggest numbers still uncertain

1. **Historical coaching P&L** — Q1 stays OPEN. Unmatched outbound $19,700
   may be coach pay; that is not written as fact. One payment is traced
   ($2,160.00, 6 Jul); the rest of the 2026 route is not. Planning does not
   wait on this: leftover coaching is not Forecast income.
2. **Two unidentified accounts** — $59,027, reachable via B64 and **only** via
   the e-transfer record: the internal-transfer data contains zero unidentified
   account numbers, so B31 cannot reach them
3. **$8,150 of cheques** — payee unknowable without TD's images

**And one that is no longer uncertain:** the $158.55 interest charge. It was
never a cash advance and never unexplained — the check was against the wrong
balance. See B7.
