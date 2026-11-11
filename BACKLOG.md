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

**Owner-instructed recurring card-charge audit** (2026-09-03). Discovery
only: `scripts/recurring-audit.js` inspects mapped revolving-credit Lunch
Money history and reports repeating merchants. It does not create or
promote Forecast bills. Phoenix / Amazon household conclusions require a
live GET-only run; synthetic tests are not household evidence.

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

**B99 · Modellers / Deep Dive / Records still carry the legacy four-link nav** · **READY** · *presentation only; found 2026-09-03*

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

`Forecast` `planHasMortgagePayment` (#1071) gates the Mortgage-label exclusion on any planned mortgage obligation with a positive amount; tie it to an occurrence of that obligation in the debit's own spending cycle, so an unplanned period's Mortgage row is never excluded. Source: #1071 pre-review observation, lead ruling.

`Forecast.hypotheticalExtraPayment` and `Forecast.hypotheticalExtraPaymentComparison` have no live consumer since Talk was removed (#1048); decide whether to retire them (engine change, full lane). Source: item-8 prune record, #821 comment 6787577449.

**Clean main view; explanations on tap** (owner direction, Dale, 2026-11-09). Every card in the app should be clean by default, with explanations moved behind a tap that opens a small window. The first target is the Savings goals card. Each row shows only the goal name, a progress bar, and how much is saved against the total needed. The status line, "Still to fund", and the "Estimate: Needed minus Saved… planning gap" sentence move into the tap-to-explain window. The trust contract still holds: a figure that is an estimate keeps a compact marker (for example ≈) on the main view, and its wording is in the window. Do the Savings goals card first, then apply the same pattern app-wide. Dale ranks it below the 1.0 money items. Source: Dale, lead session 2026-11-09.

Provider-observe `firstNumber` turns a blank, `false` or non-numeric raw balance into $0 for any account. This is the root fix (full lane); resume parked #976 on top of it. Source: lead handoff 2026-11-09.

The bill detail still lists a cross-period debit as "Possible payment" while Forecast counts it as Other spending. Source: PR #965.

`test/browser-other-period-target.js` times out (`waitForFunction`, 30 s) on unchanged `main`. Browser suites do not run in hosted CI, so nothing reports it. Find the stale wait and repair the test narrowly, without weakening its checks. Source: PR #1074.

`firstDue` card-minimum stubs print the opening-row label but are not deducted. Source: PR #977 pre-review.

A future-dated one-off settled by a #927 credit is still carried in the forward walk (pre-existing on main). Source: PR #857.

Add an inside-opening case to `test-bill-payment-excess`. Source: PR #920.

~~A stronger end-to-end HTTP test for Talk follow-ups. Source: PR #890.~~ Retired 2026-11-11 with Talk (B103).

The automated pre-review `post` job withholds a valid record when the model's text uses PASS / APPROVE vocabulary, for example when quoting test names. Narrow the filter so it does not misfire, without weakening it. Source: PR #1002 (head 34bde21).

**Due before 2026-12-02, not after 1.0:** GitHub's new default event policy blocks `pull_request_target` in public repositories. It is enforced from 2026-12-02, with scheduled brownouts before then; one blocked every PR from about 14:00 to 18:00 UTC on 2026-11-09. `privacy-guard.yml` and `risk-label-gate.yml` depend on that trigger, so a repository Actions event policy that explicitly allows it is needed. That is an owner settings action (stop 4), asked in the Plan #6 thread on 2026-11-09. Startup-failure runs cannot be re-run; only a new push or a reopen re-triggers them. Source: run 42660316051 annotation; https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target.

A zero regular-payroll override hides an already-received payroll row in the Budget/default view. Display only; received cash is correct. Pre-existing. Source: PR #921 (observation 13).

Netting refunds into Other spending understates it (G3a kept as a recorded limitation). Source: PR #927.

"Future receipts in this period" still lists a planned one-off that has already arrived. Source: PR #927.

Card inference can use a future-dated posted card balance (diagnostic only). Source: PR #924.

Settlement-evidence relief with no transaction rows gets no E row. ATLAS-080-adjacent; stays frozen with ATLAS-080. Source: PR #930.

The between-paydays operating renderer shows a pending row as "Status unresolved". Revisit the cutover assumption if provider balances turn out to exclude pending debits. Source: PR #907.

~~Talk maps null, empty or unknown confidence to calculated, and the covered answer hard-codes calculated. Fix with one shared weakest-trust helper for every Talk answer branch (named NEXT PR on #907). Source: PR #907.~~ Retired 2026-11-11 with Talk (B103).

A captured closed pay period keeps only a bill row's `date` (the period-history projection does not carry `scheduledDue`). A once row that stands in for a skipped recurring occurrence, captured after the #887 rebuild, therefore prints its real occurrence date in that closed view, not its scheduled due. Display only; no figure differs. Source: the #887 rebuild (`agent/one-off-bill-period`).

`billIsOccurrenceStub` leaves any once bill whose id extends a recurring bill's id off the Bills and Subscriptions page rosters, whether or not it stands in for a skipped occurrence. It is the same id-prefix guess #1037 demoted to a printed label on the Budget page; no pay-period figure reads it. Source: PR #1037 review.

An unknown-pending card is in flight in #951 (the #926 NEXT PR). Still open after it: headroom / "credit left" counts that card's room as 0, and per-card mark balances still use posted plus retained pending. Source: PRs #926, #951.

`test/browser/*.cjs` is not covered by the #904 browser-suite classification; owned by the #904 follow-up. Source: PR #904.

When #904 lands, the browser suite split out of #930's savings suite (`test/browser-savings-dated-balance-item-liability.js`) needs a RUN/NOT_RUN entry. Source: PRs #904, #930.

Find other registered node suites that `require('playwright')` through the harness (#930's suite never passed hosted CI; #870 had the same issue), and consider a static check that registered suites do not reach playwright. Source: PRs #930, #870.

The legacy calendar sentence "excluding bills already settled in the opening" (`public/plan.js`, period bills note) goes stale after #923; follow-up PR after #923 merges. Source: PR #923.

`scripts/positions-summary.js` sums debt balances and annual interest with `|| 0`, so a missing value counts as zero (`docs/positions.csv` only). Source: PR #901.

The Deep Dive interest note prints `money(null)` when mortgage interest is missing. Source: PR #901.

`scripts/reconcile.js` checks `settledOn` for date shape only, so an impossible calendar date passes there; #934 (A8) makes the Forecast side strict. Source: builder findings 2026-11-08, adjacent to PR #934.

`majorPlans` should withhold when card coverage is unknown. Source: builder findings 2026-11-08 (no PR yet).

"Total bills this period" needs an estimated marker when its load includes estimates. Source: builder findings 2026-11-08 (no PR yet).

A future period's bills total versus a null (unknown) bill load: the total should not print a known figure over an unknown load. Source: builder findings 2026-11-08 (no PR yet).

The GitHub merge queue needs an organization-owned public repository or Enterprise for a private one; revisit only if the repository moves to an organization. Source: lead's findings 2026-11-08.

**Dead-code cleanup of the retired repair/review-sync scripts** · *small*
The three suspended repair workflows were retired 2026-11-03. Their scripts now
have no workflow consumer: `scripts/ci-repair-privacy.js`,
`scripts/atlas-cursor-repair-gate.js`, `scripts/atlas-review-block.js`,
`scripts/atlas-merge-card-dispatch-ref.js`, `scripts/atlas-api-rereview.js` and
`scripts/atlas-github-pr-head-sync.js`, with the tests that cover them and the
`ci-output.js` identities `codex-review-gate` and `atlas-test-repair-gate`.
Confirm each has no remaining consumer, then delete script and test together.
Not urgent: nothing runs them.

Coverage rule 6 has no currency-conversion path: any non-CAD household cash/reserve row withholds (fails closed). Source: [PR #850 comment 6688280401](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/850#issuecomment-6688280401).

Coverage rule 3 hard-codes the Bills account id `chequing-a`. Source: [PR #850 comment 6688280401](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/850#issuecomment-6688280401).

A future period-history runner should treat `history-original-or-closing-conflict` as a retryable duplicate. Source: [PR #831 comment 6689055764](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/831#issuecomment-6689055764).

A pending row plus two posted copies of the same id picks `posted[0]` silently. Source: [PR #852 comment 6691030123](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/852#issuecomment-6691030123).

Two pending-only copies of one id count twice in pending gravity (conservative). Source: [PR #852 comment 6691030123](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/852#issuecomment-6691030123).

Consumers that read packet rows without the coverage gate are unchanged from main and may still double count duplicates. Source: [PR #852 card](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/852).

A Savings-paid non-item household purchase stays in the household hold (conservative). Source: [PR #851 card](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/851).

The period-history engine-commit fallback to `RENDER_GIT_COMMIT` applies on any `git rev-parse` failure (no git binary, dubious ownership, corrupt checkout), not only a missing `.git`; the engine-file dirty check is then skipped, though `filesFingerprint` still records what ran. Source: [PR #861 comment 6699577646](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/861#issuecomment-6699577646).

The capture-on-refresh worker is not unref'd, so an in-flight capture can hold server shutdown for up to its bounds (120 s). Source: [PR #861 comment 6699577646](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/861#issuecomment-6699577646).

The period-history projection holds no savings pool, savings-goal or held-balance fields, so a captured close cannot show its savings balance (it shows Unknown). Source: [PR #861 card](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/861).

A completed period's historical packet still carries `stock.reportedStock` with today's reported amount. It comes from the `...savingsFunding.stock` spread, which predates #864. Nothing renders it for a past period today: `savings-inventory.js` gates `reportedKnown` on a current packet, and the `plan.js` compact stock is date-gated. A future consumer reading `packet.stock.reportedStock` on a historical packet would leak it; withholding it there too would close the class. Source: [PR #864 comment 6702067980](https://github.com/tc5v5s64ym-sketch/Atlas-Financial/pull/864#issuecomment-6702067980).

Owner-stated wording is needed before `opts.savingsConfirmations` (owner cents / future-dated confirmation) is wired into a live path. Source: #870 note 1.

Move Node 20 to pinned 24 in the figures workflow, `privacy-guard.yml`, `standing-correction-test.yml` and `figures-review.yml`. `figures-review.yml` is pinned machinery and needs a reviewed re-pin.

Current Balance confirmation must come from positive provider evidence, not from a missing confidence tag.

The cookie Secure flag trusts the client's `x-forwarded-proto`. Owner-reserved stop 4 (Dale).

Session revocation, and rate limits on refresh and login (`/talk/ask` was removed 2026-11-11). Owner-reserved stop 4 (Dale).

Move the packet sanitizer to an allowlist (M10).

Scenario-baseline settlement evidence (A5).

Figures-check conclusion on change / incomplete (M7).

ATLAS-080 custody column UPDATE (A15). ATLAS-080 stays frozen.

`positions-summary` stale rows and the LTV claim (A21).

`calendar-ics` business days (A22).

Offline utilities and latent helpers cleanup.

Negative card balance interest (A7).

Hidden-page-only defects: delete the legacy page code after 1.0.

Merchant names in the test suites: revisit with the repo-private decision.

Privacy guard scans the net diff only, and ignores symlink targets. Security; next PR after 1.0.

Card-to-card refunds are not exercised in the harness, and there is no label for `refund-unlinked`. Source: #880 follow-up.

**HIGH priority — triage right after the current wave:** 18 browser suites fail on assertions and 19 time out. Source: #904 follow-up.

~~Talk says only "due today" for overdue items. Source: #883 follow-up.~~ Retired 2026-11-11 with Talk (B103).

Transitive npm advisories. Source: #900 follow-up.

`operating-answer.js` loads the real `periods.json` in synthetic fixtures. Source: #897 follow-up.

Recurring-audit `standingRuleFor` wording. Source: #902 follow-up.

An uncategorised store-rule row at a zero target is not counted, and an invisible-category refund is not netted. Source: #902 follow-up.

Reserve the pending look-alike as an estimated deduction. Source: #881 follow-up.

Closed trust vocabulary for `talkAnswerMetaText`. Source: #896 follow-up.

Sub-cent float noise below zero is still marked "negative". Source: #914 follow-up.

Dated-mode NULL-opening trust tags (non-visible); watch `post-balance-activity-unrepresented`. Source: #919 follow-up.

Hidden page shows "Unknown" beside a VERIFIED chip. Source: #893 follow-up.

Stale `test/browser-savings-future-closing.js`. Source: #908 follow-up.

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
