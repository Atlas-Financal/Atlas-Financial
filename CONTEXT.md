# Context for a new session

**Start at [`AGENTS.md`](AGENTS.md).** It is the universal router and owns the
read order; this file is one entry in it. Task procedure and technical
lessons load on demand as `AGENTS.md` directs; lessons are non-authoritative.

Everything below is context and current state — the layout, what has been
captured, how the site is changed, and the standing rules for working on it.
It routes nothing and states no reading order of its own. A second order lived
here until 2026-08-12 and had already drifted: it omitted two documents the
router lists and still announced the build strategy as something that did not
exist yet, months after it did.

**Current product posture (2026-08-20).** Lunch Money is the household's
**normal operational financial update feed** (owner decision 2026-08-17).
Forecast remains the sole deterministic planning and calculation authority.
Lunch Money is evidence, not the planner and not canonical household policy.
A new Lunch Money observation may overlay current posted balances and
pending onto today's live plan in memory (`scripts/live-plan.js`) without
rewriting historical openings or snapshots. When that overlay advances
past a Seaspan payday, the clone retains `plan.opening.paydaySnapshot`
from `Forecast.establishPaydaySnapshot` on the pre-overlay dated plan
only when that figure is a recorded snapshot or a completeness-proven
walk of the opening-to-payday gap on the chequing-only spendable pool
(designated savings movements do not change that reconstructed opening).
live-plan derives
that walk's `paydayGapCash` packet from the incumbent sanitized
`currentPeriodActuals` evidence. `scripts/provider-observe.js` earns
`paydayGapComplete` only when the fetch-complete posted window covers
the opening-to-payday household-cash interval, required household-cash
identities in the opening breakdown are mapped, amounts are trusted,
pending coverage is complete, and no pending-unproven gap cash remains.
A paginated-complete current-period window is not gap completeness;
live-plan withholds unless that earned attestation is present and the
window covers the gap. That clone uses the
observation's household financial date as Forecast start; unrepresented
joint-cash outflows between the dated opening and that live start stay
reserved; a complete trusted current-cash observation remains the Forecast opening when a same-day inbound is unproven (that inbound is not counted and is not labelled represented); incomplete current cash still fails closed; same-day unposted joint-cash bills stay still due. Live read-only observation
already exists and has been exercised; identity and idempotency of that
path are proved (`B78` / T3). The file foundation has not demonstrably
failed (`B79` / `AF-STORE-01`); no store is introduced. Owner-approved
preview/apply writes, the 2026-08-19 canonical opening, and the
read-only live overlay are earned (`B81` / `AF-LIVE-02`). Production
on-demand GET-only Lunch Money access is owner-authorized 2026-08-23.
The 2026-09-04 owner addenda on that same pass authorize the exhausted
one-transaction `category_id` correction and the later reusable Other
Spending `category_id` class. Every other Lunch Money interaction
remains GET-only. Unattended production writes are **not**
approved. Owner-maintained Lunch Money account
freshness is accepted owner policy and does not block unrelated
automatically refreshed accounts. The household cash schedule has one
Plan owner (`Forecast.expandEvents`, PR #37). Question OPEN / ANSWERED status
is owned by [`docs/01_OPEN_QUESTIONS.md`](docs/01_OPEN_QUESTIONS.md); Deep Dive
cannot close a question on its own. The master-forecast direction already
lives in [`ARCHITECTURE.md`](ARCHITECTURE.md). Known major future costs
already live on `plan.commitments` (`B95` / PR #82). The published Forecast
opening is 2026-08-19. The 2026-08-16 opening remains dated evidence
(`B91` / `AF-RECON-01`). Forecast is the one
master plan (`B94` / `AF-PLAN-01`): the 91-day Plan display is a view
of a ≥12-month knowledge horizon. The household payday answer is
composed from that Forecast (`B96` / `AF-PLAN-02`). Read-only assistant
access to Atlas is the incumbent `GET /assistant/current` packet (`B97`);
ChatGPT reaches that same projection through the one-tool OAuth-protected
`POST /assistant/mcp` resource. The household Talk page (`B103`) and its
`/talk/*` routes were removed on 2026-11-11 (owner decision, #821 comment
6786692208). `Forecast.hypotheticalExtraPayment` and
`Forecast.hypotheticalExtraPaymentComparison` remain as read-only Forecast
boundaries with their own suites; no household surface calls them now. The session cookie, static assistant
Bearer, and MCP OAuth do not unlock one another. Dated account-balance
openings live in `snapshots/` (`B20` / `AF-HIST-01`); `data.json` remains
the dated canonical opening. Today's live plan may overlay current
posted/pending in memory without rewriting that opening. Do not treat 9 August
conclusions as today's household truth. The critical path lives
in
[`docs/ATLAS_FINANCIAL_BUILD_STRATEGY.md`](docs/ATLAS_FINANCIAL_BUILD_STRATEGY.md).
Do not copy that sequence here. Do not treat a second month of routine
statement files as the next operational prerequisite.

Everything lives in **one folder**:

```
C:\Users\dnaud\Documents\atlas-financial
```

Open that and you have the whole project — the deployed site, the analysis, the
source data and the scripts.

## Layout

| Path | What it is | In git? |
|---|---|---|
| `server.js`, `data.json`, `public/` | The deployed site | **Yes** |
| `snapshots/` | Dated account-balance openings (history, not current state) | **Yes** |
| `docs/` | The analysis and written reports | **Yes** |
| `scripts/` | Re-runnable analysis scripts | **Yes** |
| `raw/` | Bank exports and statement PDFs | **NO — never** |
| `derived/` | Intermediate analysis output | **NO** |
| `scripts/local-config.json` | Account fragments the scripts need | **NO** |

`raw/` contains full name, home address and partial card numbers. It must never
be committed, published, or pasted into a conversation.

## `raw/` is backed up to OneDrive — run it after every capture

`raw/` is gitignored by design, so **git is not its backup**. It is mirrored
instead to `C:\Users\dnaud\OneDrive\atlas-financial-backup\raw`:

```bash
powershell -ExecutionPolicy Bypass -File scripts\backup-raw.ps1
```

Verifies file count and byte count after copying, and writes a SHA-256
`MANIFEST.txt` into the backup. It is a **mirror**, so deletions propagate —
it refuses to run against an empty source, and refuses to mirror deletions when
the source has shrunk by more than 20% unless `-Force` is passed. Currently
**manual**; see B45.

## The pre-commit hook is the safety net

`.githooks/pre-commit` **refuses any commit** that stages a file under `raw/` or
`derived/`, a `.pdf`, or — importantly — any file whose *content* contains a
personal identifier, account number or secret. It catches content-level mistakes
a `.gitignore` never could. The identifier/secret list and the scan live in
`scripts/privacy-guard.js`; the hook is the local install point. GitHub API /
connector commits never run a local hook, so CI applies the same engine from
the trusted default branch (`privacy-guard.yml`). A pull request cannot supply
the copy of the guard that judges it.

It is installed via `git config core.hooksPath .githooks`. If a fresh clone ever
loses that setting, **run that command before committing anything.** Verify it
works by staging a `raw/` file and confirming the commit is refused.

Never bypass it with `--no-verify`. The local bypass does not defeat CI.

## Read `docs/ACCOUNT_FACTS.md` before asking the owner anything

It holds every standing fact — interest rates, credit limits, payment due dates,
the mortgage renewal date, payment structures, and how each institution's data is
obtained. **The owner should never have to supply these twice.** If a fact is
missing there, add it once it is known.

Balances are not in that file; they change constantly and live in `positions.csv`
and `data.json`.

## Key documents in `docs/`

| File | What it is |
|---|---|
| `ACCOUNT_FACTS.md` | **Standing facts — rates, limits, due dates, renewal. Read first** |
| `ATLAS_FINANCIAL_BUILD_STRATEGY.md` | **Sequencing** — what to build next, subordinate to `ARCHITECTURE.md` |
| `00_MASTER_PICTURE.md` | Dated 2026-08-09 written summary — historical evidence, not current state |
| `01_OPEN_QUESTIONS.md` | The working agenda, ranked by what an answer would change |
| `evidence_use/register.json` | **Evidence-Use Register — routed or parked, for declared IDs only. Owns no financial value** |
| `knowledge_evidence/register.json` | **Knowledge-Evidence Register — external-reference claims with provenance and freshness. Informs explanation only; owns no household fact or financial value** |
| `positions.csv` | Data spine — one row per account, fixed schema |
| `MORTGAGE_HELOC_DEEP_DIVE.md` | Terms, payment splits, the May 2027 renewal |
| `CREDIT_CARD_DEEP_DIVE.md` | The TD card penalty rate and its 12-month clock |
| `dashboard.html` | The original local dashboard, superseded by the deployed site |

## Current state as at 2026-08-19

This is the product picture a new session should start from. It is **not** the
9 August first-pass capture this file used to open on, and it is **not** the
16 August dated opening.

**Published Forecast opening is 2026-08-19.** `data.json` `meta.asOf` and
`plan.opening.asOf` are that cutover. Spendable cash is the independently
summed Lunch Money mapped balances (Chequing A $629.27 + Chequing B
$309.77 + Savings $0.58 = $939.62). The 14 August payday cluster is
already inside those snapshots and is not replayed. Amanda / TENNIS INCOME
is still held-elsewhere. Q19 is ANSWERED (remaining August HELOC cash
requirement is $0 additional after the 14 August $1,100). `B91` is done. Dated
balance openings for 2026-08-09, 2026-08-16, and 2026-08-19 live in
`snapshots/`; `B20` is done. TENNIS INCOME and SAVINGS-DONT TOUCH still
have only the 2026-08-09 reading.

**Dated live acceptance — 2026-08-21 (read-only; not a canonical opening).**
The committed live-acceptance proof records **CALCULATED** spendable household
cash of $747.81 from freshness-qualified Lunch Money observations. Forecast then
produced a **CALCULATED** $104.89 opening gap on 2026-08-27, with
`funding.borrowed = 0`, `plannedDebt.permitted = false`, and an **unfunded**
household answer with no feasible weekly cap. HELOC headroom remained visible
capacity and did not become cash. See
[`docs/connectivity/LIVE_ACCEPTANCE_2026-08-21_NO_AUTO_BORROW.md`](docs/connectivity/LIVE_ACCEPTANCE_2026-08-21_NO_AUTO_BORROW.md).
This is newer committed observation evidence, not a cutover: the published and
canonical opening remains 2026-08-19, production still publishes that dated
opening, and any newer canonical opening remains an owner-reserved decision.

**Dated live closed-loop acceptance — 2026-08-25 (read-only; AF-REFRESH closed).**
The on-demand refresh loop was proved against a real Lunch Money GET using
the owner-supplied production account-map secret: observation ready, overlay
applied at household date 2026-08-25, trusted obligation reconciliation,
preview-only canonical proposal, Forecast copied not recalculated,
same-payload replay a no-op, second GET identity keys equal. Independently
summed spendable cash is **CALCULATED** −$92.17
($429.27 + (−$522.02) + $0.58). `funding.borrowed = 0`. Credit is not cash.
Canonical state was not written. See
[`docs/connectivity/LIVE_ACCEPTANCE_AF_REFRESH_07_2026-08-25.md`](docs/connectivity/LIVE_ACCEPTANCE_AF_REFRESH_07_2026-08-25.md).
The published opening remains 2026-08-19. AF-REFRESH campaign scaffolding is
retired; reusable observation, reconciliation, preview/approve, overlay,
operating-answer, and refresh-trust seams remain. `--live` still fails closed
without the owner-verified account-id map.

**Captured (broader than the old 11-account / 4,222-transaction picture):**
`data.json` `meta` currently records TD (15 accounts) · Triangle Mastercard ·
MBNA · PayPal ×2 · Wise ×2; 4,762 transactions; 48 statements. Mortgage and
HELOC terms are in. MBNA is captured. Flexiti is owner-confirmed closed
(2026-08-31): nothing remaining to pay. Affirm is a different obligation
with one final $32.53 payment due 2026-09-21, not closed. A live Lunch Money
observation pull ran on 2026-08-16; that
pull stays out of git.

**Known major future costs already have one Plan home** (`B95` / PR #82):
unsettled `plan.commitments`. Amounts, timing, flexibility, and ranges
live on those rows — do not copy them here. Vehicle maintenance stays on
`plan.commitments`; property tax stays the existing reserve. Square One
home insurance is the dated yearly card-paid `plan.bills` row, not an
undated commitment. Remaining unknowns are Q22. This is not a goals engine.

**Still outstanding / owner-blocked:** historical coaching P&L (Q1 stays OPEN
— owner-stated 2026-08-29: no shop/resale/inventory business; no other income
besides known salaries and seasonal coaching; leftover after coach pay is
gravy when it arrives, not a Forecast income line; do not invent a historical
split); verified home market value (Q3 — planning estimate is **$1,200,000** ESTIMATE
as of 2026-08-29; **$1,300,000** is optimistic high only and not the plan;
Q3 stays OPEN); WebBroker holdings (Q11 — needs an exchange-agreement
acceptance, which is the account holder's decision); the two unidentified
accounts (Q6). Q2 (where the $46,657 of TFR-TO C/C transfers go) is
**ANSWERED 2026-08-29** — only three TD credit cards exist; TFR-TO C/C is
payments to the known cards, not a missing fourth TD Visa. Q5 (why
the monthly spousal transfer stopped after May 2026) is **ANSWERED** — the
garage/lab income ended. Q12 stays OPEN without a spending
reclass. Q25 stays OPEN for the TENNIS INCOME mixed remainder.

**Do not carry these 9 August or 16 August conclusions forward as current
truth.** The 2026-08-19 opening replaced them: spendable cash is $939.62;
Burrards registrations remain settled; Triangle posted is $13,495.32 with
pending $0.00; MBNA posted is $7,875.99 with pending $0.00. The 2026-08-16
opening (spendable $2,252.76; Triangle $13,197.00 + $15.62 pending) remains
dated evidence in `snapshots/2026-08-16.json`. The HELOC crossing on this
opening is a later charge-date fact, not the 31 August registration-draw
story.

Household questions live in `01_OPEN_QUESTIONS.md`. Sequencing lives in the
build strategy. Do not invent a second list here.

## How to update the site

**Routine freshness is not a second statement download.** The intended
operating path is Lunch Money → Atlas observation + reconciliation →
current in-memory account state → Forecast → the site. Today's live plan
may overlay current posted balances and pending without rewriting
historical openings or snapshots (`scripts/live-plan.js`). The in-memory
clone starts Forecast on the observation's household financial date only
when the live packet is freshness-qualified for that date; MATCH is not
freshness, and an incomplete or stale packet fails closed.
A new canonical
opening is still an explicit owner-approved `data.json` write; automatic
production writes are not earned. File capture remains the
fallback/backfill/direct-evidence path, not the monthly operational
requirement.

A live overlay (`ATLAS_LIVE_OVERLAY=fixture` or `live`) serves today's
plan from current Lunch Money observation without that write. Production
is configured for `live` with owner-supplied Render secrets. Without those
secrets, or if live evidence cannot be trusted, Atlas publishes the dated
opening in `data.json` and says so. Unattended canonical writes remain
unauthorized.

When a published canonical figure does need to change:

1. Edit `data.json` in this repo — every figure on the site comes from it
2. **Check it renders** — see below
3. Commit and push to `main`
4. Render auto-deploys within a couple of minutes

**Adding a figure to `data.json` does not put it on the page.** A page script
has to read it and its HTML has to have somewhere to put it. Six keys once sat
in `data.json` unrendered — including the entire income section — because that
step was skipped.

The household uses only the main app at `/` (Budget). The other eight pages
below are **switched off**: one list, `SWITCHED_OFF_PATHS` in `server.js`,
answers each page and its page-only script (and their HTTP aliases) with an
authenticated 302 to `/` (owner decisions #787 6709716878 and #821
6786692208; proof `test/test-legacy-pages-switched-off.js`). Their files stay on
disk: suites read them directly, and the figures capture and the Savings
consumer guard still render `plan-spend.*` from the files. To switch a page
back on, delete its two lines from that list. `public/app.js` is the shared
core (helpers, charts, theme, boot). The table records what each file holds:

| Page | HTML | Script | What it shows |
|---|---|---|---|
| Budget (homepage `/`) | `index.html` | `plan.js` + `forecast.js` | The payday waterfall through Balance After Deductions; forecast diagnostics below |
| Forecast | `planning.html` | `planning.js` + `forecast.js` | Road Ahead Pay period: each Seaspan period's standalone `stage3.result` (prior-period surplus is not carried in). Road Ahead Month prints two separate Forecast facts: calendar-dated income received in the month (`month.income`, identity `calendar-dated-income`), and funding from Seaspan periods whose close falls in that month. Forecast publishes a separate date-order Month result so a dated requirement cannot use a later close. Those two facts are not required to equal each other. Cumulative walk cash stays internal and is not that funding result. Known future-cost list lives on Plan spend. |
| Bills | `bills.html` | `bills.js` + `forecast.js` | Recurring household bills as Credit-style fact cards: provider, amount, cadence, next date, and monthly equivalent from `Forecast.householdBills`. Subscriptions and memberships stay off this page. |
| Subscriptions | `subscriptions.html` | `subscriptions.js` + `forecast.js` | Recurring subscriptions and memberships as Credit-style fact cards: name, amount, cadence, next date, and monthly equivalent from `Forecast.householdSubscriptions`. Household bills stay off this page. |
| Credit | `credit.html` | `credit.js` + `forecast.js` | What the household owes: mortgage, HELOC, then every active card — balances, limits, Forecast.utilisation headroom, rates, next required payment from the Forecast schedule (`Forecast.creditAccounts`). The visual reference for the Bills and Subscriptions fact cards. |
| Plan spend | `plan-spend.html` | `plan-spend.js` + `forecast.js` | Leads with `Forecast.recommend.planSpendPaydayFunding`: minimum additional protection on the next Seaspan payday, then the serial payday schedule, named cost allocations, projected protected carry, payment consumption, and earliest payday funding gap. Forecast derives period capacity and daily protection bounds from its master cash walk; it does not sum Road Ahead standalone Stage 1/2 results or turn earmarks into expenses. `Forecast.majorPlans` and `Forecast.planSpendCards` retain verdicts, date/range semantics, and one Fusion display card for distinct instalments. Unknown actual saved balance stays unknown; undated requirements receive no funding payday. The page performs no financial arithmetic. |
| Modellers | `modellers.html` | `modellers.js` + `forecast.js` | Payoff and renewal modelling |

`public/forecast.js` is the engine — cash projection, debt projection, the
household-budget split, and the weekly-cap recommendation. It is pure and
DOM-free, so the node suite exercises exactly what the browser runs.

**Run `npm test` after any change to `data.json` or to a page script.**
[`test/test.js`](test/test.js) is the suite registry: it names every suite and the
dependency order they run in, and running it is the only honest way to know what
the suite currently is. This file keeps no copy of that list — a hand-maintained
inventory drifts the first time a suite is added, and then confidently describes
a test run nobody has performed. One lived here until 2026-08-12 claiming five
suites against a registry that held fifteen.

What they protect, in kind rather than by name: that the JSON parses and every
script compiles, that every id a script writes to exists, that no identifier or
secret reaches a tracked file and the security gate is intact, that the schedule
and the opening-gap recovery match hand-computed totals, that food and fuel are
provably inside the weekly cap with nothing dated counted twice, that cash out
reconciles to debt down to the cent, and that one fact keeps one home — a
contradiction between two files fails the build.

**An invariant failure is a failure, not a warning.** A plan that disagrees with
itself is worse than no plan, because it still looks authoritative.

Two things the suite deliberately cannot cover, because they need something CI
does not have: `node test/test-local.js` (needs `TEST_PASSWORD` and a running
server) and `node verify-live.js` (needs the deployed site).

### The engine owns the answers; the pages render them

`Forecast.recommend()` is the single authority for the weekly household cap.
Both the headline tile and the budget breakdown read that one result. They used
to be computed separately, and the page shipped showing `$1,650/week` at the top
and `$0/week` underneath. **Do not solve a financial question inside a page
script.** If a page needs a number that does not exist yet, add it to
`forecast.js` where it can be tested.

Check for orphans before pushing (scans every page script):

```bash
node -e "const d=require('./data.json'),fs=require('fs');const a=['app','forecast','plan','bills','subscriptions','credit','planning','plan-spend','modellers'].map(f=>fs.readFileSync('public/'+f+'.js','utf8')).join('\n');for(const k of Object.keys(d))if(!new RegExp('\\\\.'+k+'\\\\b').test(a))console.log('orphaned:',k)"
```

### Two data files, and one of them is generated

| File | Edited how | Contains |
|---|---|---|
| `data.json` | **by hand** | balances, rates, notes, questions, coverage |
| `public/periods.json` | **generated** | monthly spending, interest and fees series |

**Rebuild the generated one after the cleaned Lunch Money history changes**, or
the period selector goes stale while the rest of the page updates:

```bash
node scripts/periods.js . 2026-08-24
```

The default source is the authorized GET-only Lunch Money feed. It maps cleaned
provider categories into the incumbent Atlas categories and uses local derived
card evidence only before each mapped card's provider history begins. Mapped
HELOC interest is required: empty provider HELOC history keeps known local
HELOC interest for uncovered months, or generation fails closed. Lunch Money
Pets is not mapped; GET-only validation found that category materially
misclassified. Pass `--source local` only for the explicit file-evidence
fallback. That fallback must run where the gitignored `raw/` and `derived/`
inputs exist. The script refuses incomplete provider coverage, refuses a
mapped HELOC with no interest evidence, and refuses to publish zero events.

Pass today's date — it decides what "this month", "last month" and "year to
date" mean. It writes aggregate-only `derived/periods.json` and
`public/periods.json`; no payees, provider account IDs, transaction IDs, or raw
transactions are published. The public aggregate is read from the same
auth-gated path as `data.json`.

### Preview locally before deploying

```bash
powershell -ExecutionPolicy Bypass -File scripts\preview.ps1
```

Stages the static assets of `public/` and an **invented** `data.json` (the
synthetic household in `test/fixtures/budget-surface-data.js`) into a
directory outside the repository and serves them at <http://127.0.0.1:8899>,
bound to this machine only. It never stages the canonical `data.json` or any
`public/*.json` aggregate, because the preview has no password; previewing real
household data locally is out of scope (ask the owner). It only empties a stage
folder it made (one marked `.atlas-preview-stage`, or a new or empty one), and it
syntax-checks the page scripts before serving, so a broken change fails at the
prompt rather than as a blank page.

**Rendering check only** — the password gate and security behaviour are not
exercised. For those, `node test/test-local.js` with the password, and
`node verify-live.js` against the deployed site.

Adding an account means an entry in `debts` (and `revolvingExtra` if it is an
overdraft rather than a debt). Headline, net-worth and income totals are
derived by `Forecast.publicationTotals` from those rows — do not store a
matching copy. Add any new questions to `01_OPEN_QUESTIONS.md`, and a row to
`positions.csv`.

After changing `server.js`, run the smoke test:

```bash
TEST_PASSWORD=<the password> node test/test-local.js
```

Against the live site, `node verify-live.js` checks the security behaviour that
is visible without a password.

## Standing rules for this work

- **Read-only against financial institutions.** No transfers, payments,
  applications, setting changes, form submissions or agreement acceptances.
- **Never ask for or enter an institution login credential.** Bank passwords,
  PINs, security codes, 2FA — the owner handles all of these. On any doubt about
  whether a credential logs in as the household, stop.
- **Raw financial files stay local.** Only sanitised aggregates leave `raw/`.
- **Tag every figure** verified / calculated / estimated / unknown. An estimate
  is never presented as a verified fact.
- **Secrets live only where `ARCHITECTURE.md` permits**, and that file is the one
  home for the rule — do not restate a narrower version of it here. Configured
  secrets are supplied as Render environment secrets in production and as
  environment variables in your own shell when running locally. They are never
  in this repo, never in `data.json`, never in a log, never in any conversation,
  and never delivered to or persisted in the browser. Typing the shared password
  into the sign-in form is the secret being *used*, not stored, and is not an
  exception to that.

## Live

- Site: https://atlas-financial-o6w1.onrender.com (password-gated)
- Render service: `srv-d9scik142hec73c2q6jg`, one paid always-on Starter instance, auto-deploys from `main`
- It does not sleep when idle; it restarts on every deploy
