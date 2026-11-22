# Household card-charge evidence — 2026-09-03

This file is the source-intake record for the owner-provided read-only
card-charge audit Dale ran while signed in to Money / Lunch Money on
**2026-09-03 ~13:10 America/Vancouver**. It does not become a second facts
authority, a second Forecast, or authorization to create bills.

Discovery is not authorization. Two hits are not a bill. Recurrence is
not invented here. `plan.bills` is unchanged by this package.

Raw statements, provider ids, and credentials are not committed.

```evidence-ids
CARD-001
CARD-002
CARD-003
CARD-004
CARD-005
CARD-006
CARD-007
CARD-008
CARD-009
CARD-010
CARD-011
```

## Coverage — do not pretend 18–24 months
`CARD-001`

Actual revolving-card data in this audit: **2026-02-02 → 2026-09-03**
(~7 months). That is not 18–24 months. Absence outside this window is
not evidence of absence.

Household revolving cards only. Skip chequing, savings, HELOC, mortgage,
TENNIS INCOME, PayPal rails, and PAYMENT / AUTOPAY / THANK YOU.

| Atlas id | Lunch Money display | Txns in range | Inclusive dates |
|---|---|---|---|
| `travelvisa` | TD Canada Trust TRAVEL VISA | 215 | 2026-02-05 → 2026-09-03 |
| `cashback` | TD Canada Trust TD CASH BACK VISA* CARD | 152 | 2026-02-13 → 2026-08-27 |
| `tdcc` | TD Canada Trust PERSONAL CREDIT CARD | 17 | 2026-02-02 → 2026-08-24 |
| `mbna` | Amazon MBNA Credit Card | 7 | 2026-07-13 → 2026-08-06 |
| `triangle` | Triangle Mastercard | **ZERO** | none in range |

Triangle zero in this window is not evidence of absence, and is not
evidence that Triangle had no activity, no balance, or no bills. Do
not infer from the empty result.

## Phoenix Digital Health
`CARD-002`

Exact merchant: `Phoenix Digital Health` → `PHOENIX DIGITAL HEALTH`.
As of 2026-09-03, the discovery evidence and restrictions below applied.
Card: Travel Visa only. **Not currently planned.**

| Date | Amount | Status |
|---|---|---|
| 2026-08-05 | −$124.99 | posted |
| 2026-09-03 | −$174.99 | pending |

Interval 29 days. Amount moved $50. **Monthly is UNPROVEN.** Two hits
are not a bill. One of the two hits is within ±$15 of $179; that is not
a proven $179 bill. Do not assume gym, insurance, Amanda, or Dale. Do
not add `plan.bills`. Do not open a purpose question from this pack.

**Owner 2026-10-06 — later promotion:** Amanda's Phoenix Digital Health
bill on the Travel Visa is added at the owner's instruction.
Owner-stated planning assumption: monthly on the 3rd.
The renewal day is not invoice-verified. The October invoice is dated
2026-10-03; the bank charge followed on 2026-10-05 after retries. That
bank date is not a renewal date. Combined merchant rows can belong to
different household subscriptions and do not establish Amanda's cadence.
**Owner 2026-11-21 — due day:** Dale (via Atlas Coordinator) states the
bill is due on the 4th of each month. This supersedes the day-3 planning
assumption above for planning; `plan.bills` `phoenix-digital-health` is day 4,
firstDue 2026-10-04 (the same first planned occurrence, one day later). The
dated observations above are unchanged.
Routed to live `plan.bills` `phoenix-digital-health`; `CARD-002` is CONSUMED onto that
named bill. The category remains unconfirmed. This later instruction
does not change the dated observations above or infer a product or
purpose from the two-hit discovery.

## Amazon by card
`CARD-003`

Standing Amazon classification already lives in
[`docs/ACCOUNT_FACTS.md`](../ACCOUNT_FACTS.md) (Travel Visa and MBNA
sections). This pack does not rewrite it and does not generalize it.

- **Travel Visa:** 36 shopping charges, bursty 2026-04-04 → 2026-09-03.
  Amanda guilt-free. **Not a subscription.** Repeating Amazon shopping
  is not a bill.
- **$24.63 Prime-like charge on 2026-02-17:** not the membership. Not a
  bill. Stays outside `plan.bills` `amazon-prime`.
- **Repeated $11.19 membership:** Travel Visa `Amazon Prime` /
  `Amazon.ca Prime` on day 19 in June, July, and August 2026, plus
  $11.19 on 2026-02-17 and 2026-03-17. That membership evidence is
  declared as `CARD-011`. It is not this shopping id.
- **MBNA:** one charge 2026-07-13 −$34.71 `amzn mktp ca*…`. Amazon on
  MBNA is not automatically Amanda. No cadence. Not a bill.
- **Cash Back / Personal / Triangle:** no Amazon in this range.

Every Amazon charge is not Amanda. This pack does not recategorize.

## Recurring / strong candidates — not currently planned
`CARD-004`

Evidence only. Do not add these as bills. Two or more hits still need
owner confirmation before any later one-outcome promotion PR.

| Merchant | Card | Hits | Amounts | Cadence observed | Notes |
|---|---|---|---|---|---|
| MAILCHIMP | Travel Visa | 5 | 31.73, 32.33, 33.20, 32.81, 32.53 | monthly day 3, 2026-05-03 → 2026-09-03 | Already off subscriptions in `plan.billsNote`. Card evidence does not promote it. |
| AICHATAPP+18888287054 | Travel Visa | 4 | 44.99 × 4 | monthly day 2, 2026-06-02 → 2026-09-02 | Overlaps ChatGPT Plus **in topic only**. Different amount and day. **Not enough to call already planned.** Do not treat as `chatgpt-plus-dale` or `chatgpt-plus-amanda`. |
| CALENDLY | Travel Visa | 4 | 19.09, 19.61, 19.37, 19.17 | monthly day 2, 2026-06-02 → 2026-09-02 | Not currently planned. |
| Amazon Prime / Amazon.ca Prime $11.19 day 19 | Travel Visa | 3 | 11.19 × 3 (Jun/Jul/Aug) | see `CARD-011` | Membership evidence is `CARD-011`. This id does not consume it. |
| INTEREST CHARGE -PURCHASE | Personal Credit Card (`tdcc`) | 7 | ~36–42 | monthly ~day 23 | Revolving interest, not a new `plan.bills` row. Forecast already models card interest on the debt. |
| INTEREST CHARGE -PURCHASE | Cash Back Visa (`cashback`) | 6 | 60–159 | monthly ~day 7–8 | Same: interest on the card, not a bill. |

## Possible / needs more evidence
`CARD-005`

Do not invent recurrence. Do not add bills.

- **SHOPIFY INC/\<ref\>** | Travel Visa | 8 hits | amounts 1.12 → 26.45 → 54.88 | roughly monthly, cadence not clean.
- **MBNA:** seven transactions 2026-07-13 → 2026-08-06. Insufficient history for cadence.
- **ANNUAL FEE $25** on Personal Credit Card 2026-08-24. One observation.

## Known card hits already planned
`CARD-006`

These card hits are the same services already on the plan. This pack
does not change amount, date, or paying account.

- **BELL MOBILITY** on Travel Visa: 6 hits, lumpy. Already planned as
  undated Bell ~$121/month. Travel Visa **$250** / **$69.15** remain
  settlement/route evidence, not a proven recurring amount and not a
  fabricated due day.
- **NOBLE DISPOSAL SERVIC** on Travel Visa: 89.84 on 2026-02-09 and
  95.85 on 2026-03-18. Same service as planned quarterly
  `noble-garbage` $95.85 (`CARD-010`). This pack does not change that
  row.

## Planned services with no card hits in this window
`CARD-007`

No revolving-card hits in 2026-02-02 → 2026-09-03 for: FortisBC, Shaw,
BCAA, ICBC, RESP, Fit4Less, Netflix, Spotify, Google storage, iCloud,
YouTube Premium, Ultimate Guitar, CMAW, Telus, Affirm.

No card hit does not unplan those rows. Several already post on
chequing / BILLS ACCOUNT. Telus stays closed. Affirm stays the one
remaining $32.53 due 2026-09-21. CMAW stays cancelled. This window is
~7 months of **cards**, not the household cash ledger.

## Repeating but not a recurring bill
`CARD-008`

Amazon shopping, Uber Eats, Instacart, Walmart / Costco / 7-Eleven,
lacrosse fees, hotels. Repeat purchases are not subscriptions.

## Standing rules — preserve, do not generalize
`CARD-009`

This pack restates owner rules that were in force during the audit. It
is **not** a second `ACCOUNT_FACTS.md` and does not recategorize.

| Rule | Do not generalize to | Existing home |
|---|---|---|
| Amazon + Travel Visa → Amanda guilt-free | all Amazon; Amazon on MBNA; Prime as a bill; repeating Amazon shopping as a subscription | `docs/ACCOUNT_FACTS.md` Travel Visa and MBNA sections |
| Iron Butcher → Groceries (this merchant only) | other butchers; Surrey Meat (stays Dog food) | `data.json` groceries `why` |
| Cursor → Dale guilt-free (this merchant only) | other software / AI merchants | `data.json` dale-guilt-free `why` |
| CAN TIRE MC → Canadian Tire Mastercard payment / debt servicing | Canadian Tire retail | `public/forecast.js` CAN TIRE MC identity |
| PITT MEADOWS CE / PITTMEADOWSCE → Fuel | PITT MEADOWS AR (Sport & fitness); generic Pitt Meadows | `data.json` fuel `why` |
| 7-Eleven under $30 → Fast Food; $30+ → Fuel | all convenience stores | owner restatement in this pack; Fuel spent still requires tx-level fuel evidence for unconfirmed 7-Eleven |
| Google $3.13 SERVICE _V → `google-storage-100gb` | Pets; other Google charges | `plan.bills` `google-storage-100gb` |
| IKEA stays Insurance unless Dale says otherwise | a recategorize from this pack | owner restatement; do not retag from this file |

## Already planned (do not present as undiscovered)
`CARD-010`

Card evidence that is clearly the same service is **not** a new find.
The live schedule remains `data.json` `plan.bills`. This pack does not
add, amount-change, or date-change any row.

FortisBC ~$124 monthly; Shaw ~$78.40; BCAA ~$82.96; ICBC ~$99.91;
RESP $100; Fit4Less $11.54 every 14 days; Noble garbage $95.85
quarterly; Netflix $26.87 monthly on the 17th; Spotify $26.87 monthly
on the 17th; Google storage 100GB $3.13 around month-end; Ultimate
Guitar $50 yearly May 8; iCloud $13 monthly on the 14th; YouTube
Premium $17 monthly on the 2nd; ChatGPT Plus Dale ~$28 monthly on the
14th (estimated); ChatGPT Plus Amanda $24.99 monthly on the 14th;
Bell ~$121/month undated (Travel Visa $250 / $69.15 are
settlement/route evidence, not a proven recurring amount); Telus
CLOSED; Affirm one remaining $32.53 due 2026-09-21; CMAW $25/month
cancelled.

## Amazon Prime membership — routed from this pack's $11.19 evidence
`CARD-011`

Owner 2026-09-22: the repeated Travel Visa `Amazon Prime` /
`Amazon.ca Prime` **$11.19** charges are the confirmed membership.
Routed to live `plan.bills` `amazon-prime`. This id is that membership
evidence only.

Observed in this pack: **$11.19** on day 19 in June, July, and August
2026, plus $11.19 on 2026-02-17 and 2026-03-17. The February and March
17th hits do not move the due day. The 19 August charge is not reserved
again on the 2026-08-19 opening.

Not this id: ordinary Amazon shopping, the separate **$24.63**
Prime-like charge on 2026-02-17, MBNA Amazon, Mailchimp, AICHATAPP,
Calendly, Phoenix, Shopify, or card interest. Shopping, Mailchimp,
AICHATAPP, Calendly, Shopify, and card interest stay on `CARD-003`,
`CARD-004`, and `CARD-005` as excluded. Phoenix remains outside
`CARD-011`; its `CARD-002` route follows the owner 2026-10-06 promotion.

## What this package does not do

- Create or edit `plan.bills`.
- Write Lunch Money, recategorize, or add merchant rules.
- Promote Mailchimp, Calendly, AICHATAPP, Phoenix,
  Shopify, annual fees, or card interest to Forecast bills. The $11.19
  membership is `CARD-011`, routed after the owner 2026-09-22
  instruction. Phoenix is `CARD-002`, routed after the separate owner
  2026-10-06 instruction. Discovery alone authorizes neither promotion;
  the unrelated exclusions stay in place.
- Treat AICHATAPP $44.99 on day 2 as ChatGPT Plus.
- Treat two Phoenix hits as a monthly $179 bill.
- Claim 18–24 months of card history.
- Infer Triangle inactivity from a zero-txn window.
- Answer Phoenix purpose, payer, or product from discovery alone. The
  later owner 2026-10-06 instruction identifies Amanda and the Travel
  Visa; it does not confirm a category or infer a product or purpose.
