'use strict';
/* The financial publication correctness suite. `npm test`
 *
 * Runs every check that can be made without a password or a network, in
 * dependency order: syntax first (a broken file makes every later result
 * meaningless), then the engine, then the data it is fed, then the
 * contradictions between the two.
 *
 * An invariant failure is a FAILURE, not a warning. A financial plan that
 * disagrees with itself is worse than no plan, because it still looks
 * authoritative.
 *
 * Not run here, because they need something this process does not have:
 *   node test/test-local.js    needs TEST_PASSWORD and a running server
 *   node verify-live.js   needs the deployed site
 *
 * `test-production-live-overlay.js` starts a local server.js with synthetic
 * SITE_PASSWORD / SESSION_SECRET. Those are not production secrets.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
if (process.env.GITHUB_ACTIONS === 'true' || process.env.ATLAS_PUBLIC_CI === '1') {
  const failRunner = error => {
    try {
      const root = process.env.ATLAS_CI_DIAGNOSTICS_DIR || process.env.RUNNER_TEMP || os.tmpdir();
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const dir = fs.mkdtempSync(path.join(root, 'atlas-ci-runner-private-'));
      fs.chmodSync(dir, 0o700);
      fs.writeFileSync(path.join(dir, 'error.log'), String(error && error.stack || error), { mode: 0o600 });
    } catch { /* Reporting failure must not expose the original error. */ }
    fs.writeSync(2, JSON.stringify({ type: 'ci-runner-error', identity: 'test.js',
      status: 'fail', category: 'runner-failed', exitCode: 1 }) + '\n');
    process.exit(1);
  };
  process.on('uncaughtException', failRunner);
  process.on('unhandledRejection', failRunner);
}
const CiOutput = require('../scripts/ci-output');

const ROOT = path.join(__dirname, '..');

const suites = [
  ['INT-3 offline provider-operation lifecycle and uncertainty', 'test-settlement-evidence-int3-provider-operation.js'],
  ['INT-3 offline RQ8 provider restore scenario composing B, never qualification', 'test-settlement-evidence-int3-provider-restore-case.js'],
  ['INT-3 offline session lifecycle and sanitized retirement', 'test-settlement-evidence-int3-session.js'],
  ['signed per-login session identity and legacy read compatibility', 'test-session-identity.js'],
  ['shared read-only transaction review presentation and privacy boundary', 'test-transaction-review.js'],
  ['public CI output and synthetic privacy canaries', 'test-ci-output.js'],
  ['serial runner, complete CI partition and aggregation contracts', 'test-ci-split.js'],
  ['annual savings expense excluded from payday Bills with one conserved draw', 'test-annual-savings-payperiod.js'],
  ['owner-approved streaming bills on the incumbent held-elsewhere Wise path', 'test-owner-streaming-bills.js'],
  ['selector locale formatter equivalence', 'test-selector-formatters.js'],
  ['private pay-period retention, immutable revisions and privacy boundaries', 'test-private-period-history.js'],
  ['private pay-period history declared completeness, closing gate and legacy v1 compatibility', 'test-private-period-history-completeness.js'],
  ['private pay-period history rollover closing capture seam (issue #818 slice 1)', 'test-private-period-history-closing-capture.js'],
  ['private pay-period history storage contract: one suite run against the file and hosted PostgreSQL backends (append-only, idempotent retry, conflict, hash read-back, fail-closed)', 'test-private-period-history-store-contract.js'],
  ['private pay-period history hosted PostgreSQL backend: closed sanitized projection, provider-text sentinel, verify-full connection string and period-history connection profile (offline injected Client)', 'test-private-period-history-postgres.js'],
  ['private pay-period history against a local disposable PostgreSQL built from the owner setup SQL; skipped as UNRUN (never PASS) unless ATLAS_PERIOD_HISTORY_LOCAL_PG_BIN is set', 'test-private-period-history-postgres-local.js'],
  ['one chronological savings publication and independent allocation oracle', 'test-chronological-savings-publication.js'],
  ['latest reported Savings allocations with unchanged native funding gates', 'test-savings-latest-known-allocation.js'],
  ['present reported Savings earmarks independent of historical reconciliation', 'test-reported-savings-earmarks.js'],
  ['future Savings closing surplus, native cash conservation and receipt inclusion', 'test-savings-future-closing.js'],
  ['PA-1 Decision 1: estimated future Savings close under an unqualified movement; guards and verified path unchanged', 'test-savings-estimated-future-closing.js'],
  ['PA-2a Decision 2: Still to fund = max(0, Needed - Saved), estimated, only with both inputs known', 'test-savings-still-to-fund.js'],
  ['PA-2b Decision 2: the Budget goals list renders row-owned Still to fund with its estimate mark and reason; legacy join retired', 'test-savings-still-to-fund-render.js'],
  ['PA-3 Decision 1: an elapsed goal retires from later projected periods; current visibility and closing gate unchanged', 'test-savings-elapsed-goal-relisting.js'],
  ['PA-4a-1: opening-inclusive planned period close, estimated only under card-matching holds, null under hard holds, trust carried', 'test-pa4-planned-period-close.js'],
  ['PA-4a-2a: one coverage-evidence view per run; string and object complete stamps agree, contradictions stay hard', 'test-pa4a2a-coverage-evidence-view.js'],
  ['PA-4a-2b: card-matching cash-terms bridge; one qualified remaining requirement feeds the seed, Budget walk and Savings close', 'test-pa4a2b-cash-terms-bridge.js'],
  ['R1: ready card coverage keeps an uncovered purchase protected once across the seed, every later sweep and Savings arrivals', 'test-r1-ready-path-card-protection.js'],
  ['separate bank EOD reconstruction anchor, historical preservation and Savings conservation', 'test-payday-bank-eod-anchor.js'],
  ['payday surplus sweep: full prior surplus lands on the next payday, routine deficits stay visible and uncovered', 'test-savings-payday-sweep.js'],
  ['S1 payday sweep: full available remainder incl. inherited cash sweeps, Budget opening and Savings credit consume the same published sweep', 'test-savings-payday-sweep-s1.js'],
  ['qualified Bills-only sweep: complete evidence, exact current stock and no unavailable-credit fallback', 'test-savings-sweep-qualified-basis.js'],
  ['payday sweep review regressions: available-cash bound, unspent-sweep attribution', 'test-savings-sweep-review-regressions.js'],
  ['selected future Savings requirement roster independent of monetary qualification', 'test-savings-selected-roster.js'],
  ['real observer Savings movement provenance and legacy fail-closed contract', 'test-savings-observer-contract.js'],
  ['Savings TD card recipient class with unchanged posted/source/cutoff qualification', 'test-savings-card-recipient.js'],
  ['combined savings location conservation and publication gates', 'test-chronological-savings-conservation.js'],
  ['independent savings review boundary and pre-payday conservation controls', 'test-chronological-savings-review-boundaries.js'],
  ['scheduled fee actual cost, reserve and bounded bill recognition', 'test-scheduled-fee-routing.js'],
  ['real financial calendar identity and hypothetical conservation', 'test-financial-calendar-identity.js'],
  ['posted income and unresolved future occurrence cash gate', 'test-early-income-uncertainty.js'],
  ['bounded live refresh and client cancellation', 'test-live-refresh-deadline.js'],
  ['equivalent in-flight refresh sharing, caller isolation and sanitized timings', 'test-live-refresh-coalescing.js'],
  ['private qualified observation reuse, Manual Refresh, context and restart', 'test-server-observation-memory.js'],
  ['bounded shared browser data load and truthful retry', 'test-browser-data-deadline.js'],
  ['source check metadata and independent financial coverage status', 'test-source-check-status.js'],
  ['explicit private comparison save from complete loaded inputs only', 'test-private-comparison-download.js'],
  ['inactive private planned-input correction contract and synthetic validation', 'test-planned-input-contract.js'],
  ['inactive private planned bill amount correction contract and synthetic validation (#768 Slice 1)', 'test-planned-bill-input-contract.js'],
  ['inactive planned-obligation settlement evidence contract and synthetic validation', 'test-planned-obligation-settlement-contract.js'],
  ['settlement evidence relief through Forecast: remaining, cash events and backing (Phase 2)', 'test-savings-settlement-phase2.js'],
  ['paid Savings goals retained through completion period and retired afterward', 'test-savings-paid-goal-lifecycle.js'],
  ['settlement evidence loader: pin-verified reads, unconfigured/qualified/unavailable outcomes', 'test-settlement-evidence-loader.js'],
  ['settlement evidence store: commit/recovery state machine, journal, pin CAS and restore drills', 'test-settlement-evidence-store.js'],
  ['settlement evidence file adapter: private POSIX persistence, cross-process lock and restart proof', 'test-settlement-evidence-file-adapter.js'],
  ['settlement evidence object adapter: conditional pin CAS, encrypted backups and manifest integrity', 'test-settlement-evidence-object-adapter.js'],
  ['settlement evidence GCS transport: disconnected generation CAS and stable-namespace pagination (offline request fixtures)', 'test-settlement-evidence-gcs-transport.js'],
  ['settlement evidence restore qualification: offline owner-assisted drill, restore-then-continue and blast-radius pins (ATLAS-080)', 'test-settlement-evidence-restore-qualification.js'],
  ['settlement evidence publication gating: configured-unavailable withholding at the packet, Planning and Plan surfaces (ATLAS-080)', 'test-settlement-evidence-publication-gating.js'],
  ['settlement evidence server seam: default-inactive bridge from the shared served data to the loader outcome (ATLAS-080)', 'test-settlement-evidence-server-seam.js'],
  ['inactive Savings assignment real HTTP journey', 'test-settlement-evidence-http.js'],
  ['compressed input rejected before parsing on the core request surface', 'test-server-compressed-input.js'],
  ['settlement evidence serving: receipt-bound qualified publication read over the construction-fixed serving dependency (ATLAS-080)', 'test-settlement-evidence-serving.js'],
  ['settlement evidence confirmation: synthetic session-bound prepare/confirm/outcome with atomic no-recovery commits (ATLAS-080)', 'test-settlement-evidence-confirmation.js'],
  ['settlement evidence terminal certificate: irreversible operation seal, certificate-after-seal and modelled atomic fencing (ATLAS-080)', 'test-settlement-evidence-terminal-certificate.js'],
  ['settlement evidence restore input: disconnected non-mutating exact-anchor pair validator, no install or listing authority (ATLAS-080)', 'test-settlement-evidence-restore-input.js'],
  ['settlement evidence restore install: disconnected maintenance quarantine-then-install and fresh-session readback over SQL doubles, installed-unverified only (ATLAS-080)', 'test-settlement-evidence-restore-install.js'],
  ['settlement evidence owner restore command: explicit private inputs, qualified dedicated maintenance sessions, confirmed closure and fresh read-only verification (ATLAS-080)', 'test-restore-settlement-evidence.js'],
  ['settlement evidence INT-3 maintenance profile: offline declared-manifest requirements validator bound to the owner restore contract, compatibility never qualification (ATLAS-080)', 'test-settlement-evidence-int3-maintenance-profile.js'],
  ['settlement evidence INT-3 restore request: offline custody binding, stale substitution refusal and owner command contract, never qualification (ATLAS-080)', 'test-settlement-evidence-int3-restore-request.js'],
  ['settlement evidence resolver foundation: pure identity/binding foundation — txRef v1, BIND bindings, canonical-row crosswalk and handles (ATLAS-080)', 'test-settlement-evidence-resolver.js'],
  ['settlement evidence crosswalk exporter: same-pass tuple provenance from the incumbent sanitizer pass (ATLAS-080)', 'test-settlement-evidence-crosswalk.js'],
  ['settlement evidence refresh acquisition: memory-replay-only private acquisition through the refresh worker/lifecycle (ATLAS-080)', 'test-settlement-evidence-refresh-acquisition.js'],
  ['settlement evidence PostgreSQL adapter: injected-session SQL local state, lost-ack ambiguity and session-loss invalidation (ATLAS-080)', 'test-settlement-evidence-postgres-adapter.js'],
  ['settlement evidence PostgreSQL connection: exclusive verified session ownership and bounded retirement (offline injected Client)', 'test-settlement-evidence-postgres-connection.js'],
  ['settlement evidence PostgreSQL runtime: default-disconnected factory/store/application composition (offline doubles)', 'test-settlement-evidence-postgres-runtime.js'],
  ['settlement evidence B4 re-login recovery: default-disabled policy-gated cross-login outcome/publication recovery with private bundle binding (ATLAS-080)', 'test-settlement-evidence-b4-recovery.js'],
  ['settlement evidence authorization store: disconnected append-only authorization state over an exclusively owned dedicated session, scope-keyed eligibility/revocation records and one-statement state reads (ATLAS-080)', 'test-settlement-evidence-authorization-store.js'],
  ['settlement evidence authorization connection: disconnected connection ownership, TLS and catalog preflight over exactly the three authorization relations, constructing the authorization store inside over a bounded dedicated session (offline injected Client)', 'test-settlement-evidence-authorization-connection.js'],
  ['settlement evidence cross-witness: append-only anchor-observation log, greatest (incarnation, epoch) head and session-loss retirement over an injected session (INT-5 P-5 anchor slice S3)', 'test-settlement-evidence-cross-witness.js'],
  ['settlement evidence cross-witness connection: disconnected witness-profile preflight over exactly the observation relation, constructing the cross-witness inside over a bounded dedicated session (offline injected Client, INT-5 P-5 anchor slice S3)', 'test-settlement-evidence-cross-witness-connection.js'],
  ['settlement evidence anchor store: genesis-bound CAS records, retained generations in generation order and crash-safe intent/ack provenance over an injected object transport (INT-5 P-5 anchor slice S1)', 'test-settlement-evidence-anchor-store.js'],
  ['settlement evidence recovery-to-server integration: durable eligibility issuance inside prepare, the recovery-secret credential on both disclosing routes, and the opt-in awaited final authority authorizeRecoveryFinal judged on one fresh store read (planner-trial Lane 1, ATLAS-082)', 'test-settlement-evidence-recovery-integration.js'],
  ['settlement production startup: two owners, retained uncertainty, single final authority and logout tombstones (synthetic assembled ATLAS-083)', 'test-settlement-production-composition.js'],
  ['household Savings journey end-to-end acceptance (test only)', 'test-savings-journey-acceptance.js'],
  ['settlement production owners: synchronous authorize, preliminary recovery admission, trusted context revision and synthetic custody composition (Plan #5 P1)', 'test-settlement-production-owners.js'],
  ['settlement production host: composition root wiring P1 owners into startServer, GAP-2 read facade lifecycle, canonical-file context adapter, custody-session preflight and confirmed custody closure (Plan #5 assembly)', 'test-settlement-production-host.js'],
  ['settlement custody durable stores: Postgres-backed pin/backup custody over one dedicated direct session, restart persistence and fail-closed corruption (Plan #5 GAP-1)', 'test-settlement-custody-durable-stores.js'],
  ['settlement evidence age process control: bounded child run accepts complete output only on exit zero, stderr never surfaced (process doubles, not age crypto proof; Plan #5 P6, PR #780)', 'test-settlement-evidence-age-process.js'],
  ['settlement evidence official age interoperability on synthetic fixtures; skipped as UNRUN (never PASS) unless ATLAS_P6_AGE_BINARY names a verified binary (Plan #5 P6, PR #780)', 'test-settlement-evidence-age-synthetic.js'],
  ['A9 unknown operation over the assembled production host: tainted pin/checkpoint fail closed, untainted control prepares (Plan #6 A9, PR #790)', 'test-a9-unknown-operation-host.js'],
  ['A12 acceptance host entry: actual entry refuses at construction naming the unbound seam (Plan #6 A12, PR #791)', 'test-a12-acceptance-host-entry.js'],
  ['A12 active entry journey against local disposable PostgreSQL: gate probe runs, journey recorded NOT EXECUTED via skips, never PASS (Plan #6 A12, PR #791)', 'test-a12-active-entry-local-pg.js'],
  ['A12 assembled host suspending double: bounded connect, no substitution, unknown-write uncertainty preserved (Plan #6 A12, PR #791)', 'test-a12-suspending-double-host.js'],
  ['salary diagnostic native candidate attribution and cross-slot conservation', 'test-salary-diagnostic-candidates.js'],
  ['bounded salary occurrence diagnostic scope and conservation', 'test-salary-diagnostic-occurrences.js'],
  ['recorded household minimum action stays separate from issuer settlement', 'test-bills-recorded-payment.js'],
  ['Bills header includes recorded minimum money without changing original requirements', 'test-bills-header-payments.js'],
  ['Bills-only expected period-end balance and fulfilled funding evidence', 'test-bills-period-end-balance.js'],
  ['independent Bills closing negative controls', 'test-bills-period-end-negative-controls.js'],
  ['Bills native unknown amounts and account-specific future cash', 'test-bills-period-end-native-requirements.js'],
  ['card minimum repair stock, proof and identity conservation', 'test-card-minimum-repair-conservation.js'],
  ['selected Seaspan card movement endpoints, coverage and conservation', 'test-card-period-movements.js'],
  ['card detail panel lead and balance disclosure placement', 'test-card-panel-lead.js'],
  ['card-window allocation diagnostics through synthetic provider evidence', 'test-card-payment-diagnostics.js'],
  ['card allocation diagnostic identity and parent dependency regressions', 'test-card-payment-diagnostic-dependencies.js'],
  ['inert private card decision controller with real Forecast validation', 'test-card-payment-decisions.js'],
  ['private card decision typed store, operation outcomes and POSIX durability', 'test-card-payment-decision-store.js'],
  ['card statement cycle replacement and sender-only minimum evidence', 'test-card-minimum-cycle-contract.js'],
  ['bounded strict card-minimum date validation', 'test-card-minimum-date-cache.js'],
  ['card minimum issuer confirmation across advancing live refreshes', 'test-card-minimum-issuer-lifecycle.js'],
  ['owner-confirmed carried minimum and later-cycle isolation', 'test-confirmed-carried-card-minimum.js'],
  ['Triangle owner-confirmed paid without duplicate cash or principal', 'test-triangle-owner-confirmed-paid.js'],
  ['hypothetical savings timeline and independent pool conservation', 'test-savings-funding-timeline.js'],
  ['daily savings backing and transfer-neutral capacity', 'test-savings-daily-allocation-contract.js'],
  ['daily savings external null-alias contract and preserved gates', 'test-savings-daily-external-alias-contract.js'],
  ['daily savings incumbent financial probes', 'probe-savings-daily-allocation-incumbent.js'],
  ['active daily Budget Savings consumer contracts', 'test-savings-daily-consumer.js'],
  ['grouped savings rows expose published member rows on both surfaces', 'test-savings-group-members.js'],
  ['Travel Visa annual fee excluded from Savings and shown under Bills', 'test-travel-visa-annual-fee.js'],
  ['v2 observed savings semantic date and independent Budget stock', 'test-provider-v2-savings-stock.js'],
  ['Savings source qualification across current and selected future periods', 'test-savings-source-qualification-acceptance.js'],
  ['v2 semantic credit dates, qualified live stock and active Credit renderer', 'test-provider-v2-credit-date.js'],
  ['native utility settlement units and independent holds', 'test-utility-settlement-currency.js'],
  ['paid actual display trust remains separate from estimated schedules', 'test-paid-actual-display-trust.js'],
  ['one household actual/planned total and Other remaining display', 'test-budget-household-total-display.js'],
  ['print-only Balance After Deductions terms close to the cent or print Unavailable', 'test-bad-terms-print.js'],
  ['Budget river withholds historical BAD and preserves native selection', 'test-bad-timeline-river.js'],
  ['Household tile whole-dollar face rounds each published token once', 'test-household-whole-dollars.js'],
  ['clean browser proof source binding and immutable publication', 'test-proof-source-binding.js'],
  ['Budget detail sheet preserves original nodes, nested focus and remount identity', 'test-budget-detail-sheet-controller.js'],
  ['positions reporting evaluates the disclosed owner-target date', 'test-positions-owner-target-date.js'],
  ['dated owner Other payday target and once-only reserve', 'test-other-period-target.js'],
  ['effective-dated Fuel payday budget and historical boundary', 'test-fuel-effective-target.js'],
  ['purpose-reserve funding seed and independent payment conservation', 'test-reserve-aware-funding.js'],
  ['purpose-reserve authenticated funding and both page consumers', 'test-reserve-aware-funding-integration.js'],
  ['Lunch Money provider amount precision and sanitized read failures', 'test-assistant-provider-amounts.js'],
  ['Lunch Money transaction delta read (change feed, never a ledger or audit stream)', 'test-provider-transaction-delta.js'],
  ['Lunch Money transaction delta consumer contract (inert, harness-only)', 'test-provider-transaction-delta-consumer.js'],
  ['MCP provider account balances and truthful freshness', 'test-assistant-account-balances.js'],
  ['Lunch Money monthly balance history read (monthly only, unavailable never zero)', 'test-assistant-balance-history.js'],
  ['Lunch Money MCP reads and confirmed bounded edits', 'test-assistant-lunchmoney.js'],
  ['Lunch Money preserving metadata and reusable cleanup previews', 'test-assistant-cleanup.js'],
  ['Bounded automatic routine cleanup, real financial effects and private history', 'test-assistant-routine-cleanup.js'],
  ['owner-selected purpose savings and explicit staging cutover', 'test-purpose-savings.js'],
  ['confirmed savings earmarks and independent cash conservation', 'test-savings-earmarks.js'],
  ['property-tax savings reference to incumbent Budget reserve', 'test-savings-property-tax.js'],
  ['confirmed savings authenticated observation and both surfaces', 'test-savings-earmarks-integration.js'],
  ['confirmed savings immutable main before/after', 'test-savings-earmarks-before-after.js'],
  ['one household ledger across observed Budget and savings', 'test-household-path.js'],
  ['Visa payment backfill reconciliation', 'test-visa-payment-backfill.js'],
  ['immediate evidence-qualified card purchase coverage', 'test-card-purchase-coverage.js'],
  ['owner aggregate card coverage rule: per card, per pay period, posted pairs only', 'test-card-coverage-aggregate-rule.js'],
  ['cardCoverageState computed once per payday cent search, output unchanged', 'test-cardcoverage-probe-reuse.js'],
  ['card purchase markers retain expense and whole-ledger trust', 'test-card-purchase-tracker.js'],
  ['read-only bill payment evidence and exact sanitized links', 'test-bill-detail.js'],
  ['transaction edit form (isolated, mock adapter)', 'test-transaction-edit.js'],
  ['Budget bill payment evidence integration and hooks', 'test-bill-detail-budget-integration.js'],
  ['from-today Budget savings arithmetic and evidence', 'test-from-today-funding.js'],
  ['from-today observation to Budget integration', 'test-from-today-integration.js'],
  ['savings evidence holds and independent gates', 'test-savings-evidence.js'],
  ['savings evidence authenticated server and Budget', 'test-savings-evidence-integration.js'],
  ['selected Budget missing-income occurrence funding', 'test-budget-missing-income-funding.js'],
  ['pending-card Budget funding and settlement conservation', 'test-budget-pending-card-funding.js'],
  ['early posted card-bill protection and pending status', 'test-posted-card-bill-protection.js'],
  ['card-bill protection through confirmed backfill lifecycle', 'test-card-bill-protection-lifecycle.js'],
  ['secondary Budget failed-cap spending basis', 'test-budget-secondary-spending-basis.js'],
  ['owner-approved unpaid Burrards team-fee inputs', 'test-burrards-team-fee-inputs.js'],
  ['exact deployed PR provenance', 'test-build-provenance.js'],
  ['Budget running build identity', 'test-running-build.js'],
  ['Budget release detection on resume', 'test-app-release-resume.js'],
  ['phone startup entry: web app manifest, brand icons and head metadata pin the launch to /', 'test-startup-manifest.js'],
  ['current-period actuals stay in the Seaspan spending cycle', 'test-current-period-cycle-actuals.js'],
  ['settled commitments do not reappear in the action lookback', 'test-settled-cost-lookback-action.js'],
  ['static sanity', 'test-static.js'],
  ['incumbent privacy guard (B77)', 'test-privacy-guard.js'],
  ['source line-ending independence', 'test-line-endings.js'],
  ['forecast engine + opening-gap regression', 'test-forecast.js'],
  ['walk-derived additionalCashRequired (chequing-only zero floor)', 'test-additional-cash-required.js'],
  ['opening-gap recovery does not auto-borrow', 'test-opening-gap-no-auto-borrow.js'],
  ['quarterly recurrence (every 3 months)', 'test-quarterly-recurrence.js'],
  ['owner-confirmed subscription bills', 'test-owner-subscription-bills.js'],
  ['Amazon Prime membership subscription', 'test-amazon-prime-membership.js'],
  ['Phoenix Digital Health card-paid bill', 'test-phoenix-digital-health-bill.js'],
  ['income dependency deadline', 'test-income-deadline.js'],
  ['next due obligation', 'test-next-due.js'],
  ['next payment out', 'test-next-payment-out.js'],
  ['household schedule authority', 'test-schedule-authority.js'],
  ['question status authority', 'test-question-status.js'],
  ['unallocated / free cash', 'test-unallocated-cash.js'],
  ['compact snapshot', 'test-compact-snapshot.js'],
  ['publication totals', 'test-publication-totals.js'],
  ['homepage mission', 'test-mission.js'],
  ['plan status band + funding verdicts', 'test-status-band.js'],
  ['plan status unquantified presentation', 'test-plan-status-unquantified.js'],
  ['what the next move achieves', 'test-nextmove.js'],
  ['a withheld cash walk is unavailable in status, mission and next move', 'test-sim-unavailable-guard.js'],
  ['gap counterfactuals', 'test-counterfactuals.js'],
  ['May 2027 renewal', 'test-renewal.js'],
  ['payoff modeller', 'test-payoff.js'],
  ['household budget reconciliation', 'test-budget.js'],
  ['workbook evidence cannot overwrite owner policy', 'test-workbook-authority.js'],
  ['Groceries $900 per Seaspan pay period', 'test-groceries-payday-monthly.js'],
  ['Other spend $800/month owner target', 'test-other-spend-owner-target.js'],
  ['Other spend is not a Household Budget calendar hold', 'test-other-spend-calendar-hold.js'],
  ['future pay-period Other Spend reserve', 'test-future-other-spend-reserve.js'],
  ['spending classification reconciliation', 'test-classification.js'],
  ['Lunch Money historical actuals authority (AF-OPERATE-01)', 'test-periods-lunchmoney.js'],
  ['read-only recurring card-charge audit', 'test-recurring-audit.js'],
  ['Lunch Money recurring items read (provider evidence, never Forecast bills or proof of payment)', 'test-provider-recurring-items.js'],
  ['decision-first payday operating surface (AF-OPERATE-02)', 'test-operating-surface.js'],
  ['plain-language household homepage', 'test-household-view.js'],
  ['approved Budget UI presentation', 'test-budget-ui-polish.js'],
  ['Budget review future settlement and zero-plan markers', 'test-budget-review-regressions.js'],
  ['Budget exact-period original plans and observed progress', 'test-budget-period-progress.js'],
  ['Salary receipt and paired transfer actual-income proof', 'test-income-transfer-receipts.js'],
  ['Bounded salary matcher diagnostic conservation and redaction', 'test-salary-matcher-diagnostic.js'],
  ['Salary matcher diagnostic existing authenticated readback', 'test-salary-diagnostic-auth.js'],
  ['active Budget surface: one renderer, Forecast figures, drilldown and withheld states', 'test-budget-surface.js'],
  ['Budget owner-voice presentation', 'test-budget-owner-voice.js'],
  ['Budget hero cannot borrow whole-window confidence', 'test-budget-plan-status-scope.js'],
  ['Plan homepage decision desk', 'test-plan-decision-desk.js'],
  ['cash-waterfall household homepage', 'test-cash-waterfall-view.js'],
  ['chequing availability headline', 'test-chequing-availability.js'],
  ['Current Balance is planning-hub cash only', 'test-current-balance-chequing-cash.js'],
  ['null Bills opening is not a confirmed zero', 'test-null-bills-opening-not-confirmed-zero.js'],
  ['malformed scheduled amounts fail closed as unknown', 'test-malformed-amounts-fail-closed.js'],
  ['ATLAS-077 household consumer acceptance for malformed scheduled amounts', 'test-atlas-077-malformed-amounts.js'],
  ['ATLAS-075 bill amount schedule promo pricing and regular-price restoration', 'test-bill-amount-schedule.js'],
  ['Dale payday Current Balance assumption', 'test-dale-payday-current-balance.js'],
  ['live payday pre-BILLS base retain', 'test-live-payday-bills-base.js'],
  ['ordered payday action sheet (AF-OPERATE-03)', 'test-operate-payday-action-sheet.js'],
  ['between-paydays operating view (AF-OPERATE-04)', 'test-operate-between-paydays.js'],
  ['future financial gravity (AF-OPERATE-05)', 'test-operate-future-gravity.js'],
  ['required and extra debt answer (AF-OPERATE-06)', 'test-operate-debt-answer.js'],
  ['payday operating-surface acceptance (AF-OPERATE-07)', 'test-operate-payday-acceptance.js'],
  ['payday operating sheet six glance answers', 'test-payday-operating-sheet.js'],
  ['Plan default view layout', 'test-plan-default-view.js'],
  ['This payday printout layout order', 'test-this-payday-layout-order.js'],
  ['household nav and Plan waterfall boundary', 'test-household-nav-plan-boundary.js'],
  ['household nav mobile presentation', 'test-household-nav-presentation.js'],
  ['Talk to Atlas household surface', 'test-talk-page.js'],
  ['Talk context packet seam', 'test-talk-context.js'],
  ['Talk Gemini explainer turn', 'test-talk-ask.js'],
  ['Talk structured answer cards', 'test-talk-cards.js'],
  ['Talk citations / provenance (Queue PR 2)', 'test-talk-citations.js'],
  ['Talk household decision summary', 'test-talk-decision-summary.js'],
  ['Talk multi-turn session context (Queue PR 3)', 'test-talk-session.js'],
  ['Talk safe streaming (Queue PR 4)', 'test-talk-stream.js'],
  ['Talk deterministic Why? explanation', 'test-talk-why.js'],
  ['Talk verified follow-up references', 'test-talk-followup-refs.js'],
  ['Talk payday leftover from Forecast.runningLeftover', 'test-talk-payday-leftover.js'],
  ['Talk payday operating picture from Forecast.paydayAllocation', 'test-talk-payday-picture.js'],
  ['Talk payday remaining bills from Forecast.obligations.items', 'test-talk-payday-remaining-bills.js'],
  ['Talk Which one? after earned A-vs-B (B103 Slice 4)', 'test-talk-which-one-preference.js'],
  ['Talk hypothetical extra adapter (Talk Slice 6B)', 'test-talk-hypothetical.js'],
  ['owner decision posture policy (Talk Slice 5)', 'test-decision-posture.js'],
  ['hypothetical extra-payment scenario (Talk Slice 6)', 'test-hypothetical-extra-payment.js'],
  ['hypothetical extra-payment comparison (Decision Intelligence foundation)', 'test-hypothetical-extra-payment-comparison.js'],
  ['Forecast baseline trajectory (Financial Trajectory)', 'test-baseline-trajectory.js'],
  ['Forecast baseline trajectory three-stage funding decomposition', 'test-baseline-trajectory-funding-stages.js'],
  ['Forecast stage1 income named Dale/Amanda lines', 'test-baseline-trajectory-income-lines.js'],
  ['Forecast stage1 bills / obligations / householdBudget named lines', 'test-baseline-trajectory-stage1-component-lines.js'],
  ['Forecast Road Ahead Household Budget category lines', 'test-household-budget-trajectory-lines.js'],
  ['Forecast stage2 commitment named lines', 'test-baseline-trajectory-stage2-commitment-lines.js'],
  ['Forecast baseline trajectory pay-period series (B105l)', 'test-baseline-trajectory-pay-period-series.js'],
  ['Forecast provisional recent pay-period normal spending', 'test-provisional-normal-spending-baseline.js'],
  ['Road Ahead standalone period surplus/deficit', 'test-standalone-road-ahead-surplus.js'],
  ['Road Ahead independent Month / Pay Period financial reconciliation', 'test-road-ahead-reconciliation.js'],
  ['Road Ahead Month surplus by Seaspan pay-period close', 'test-road-ahead-month-close.js'],
  ['Road Ahead Month calendar income vs close surplus', 'test-road-ahead-month-income.js'],
  ['Road Ahead Month close-period reconciliation', 'test-road-ahead-month-reconciliation.js'],
  ['Forecast residual pay-period identity vs Budget This Pay Period', 'test-pay-period-residual-identity.js'],
  ['Forecast baseline trajectory additional-debt-payment scenario (O4)', 'test-baseline-trajectory-scenario.js'],
  ['Dale/Seaspan estimated payroll regime (independent stubs)', 'test-dale-payroll-regime.js'],
  ['Credit page — what do we owe (Forecast.creditAccounts)', 'test-credit-page.js'],
  ['Credit descriptions preserve served monetary authority', 'test-credit-description-authority.js'],
  ['Planning page — Forecast.majorPlans rendered', 'test-planning-page.js'],
  ['Plan spend page — Forecast.majorPlans reprinted', 'test-plan-spend-page.js'],
  ['Plan spend roster 2026-09-23 — retired costs, Fusion card, San Diego once', 'test-plan-spend-roster-2026-09-23.js'],
  ['Planning Road Ahead phone-native presentation', 'test-planning-road-mobile-presentation.js'],
  ['Planning Road Ahead before / planned / after decision story', 'test-planning-road-decision-story.js'],
  ['Bills page — Forecast.householdBills rendered', 'test-bills-page.js'],
  ['Subscriptions page — Forecast.householdSubscriptions rendered', 'test-subscriptions-page.js'],
  ['Plan calendar bill sections', 'test-plan-bill-calendar-periods.js'],
  ['Plan calendar waterfalls', 'test-plan-calendar-waterfalls.js'],
  ['Dog food every-other-Seaspan payday cadence', 'test-dog-food-monthly-cadence.js'],
  ['Household planned target removed', 'test-household-target-removed.js'],
  ['Household Budget Other spending residual', 'test-household-budget-other-spending.js'],
  ['Uncategorised debit enters Other Spending once', 'test-uncategorised-other-spending.js'],
  ['Household Budget Spent transaction drill-down', 'test-household-budget-spent-drilldown.js'],
  ['Household Budget overlay Spent drill-down when recon withheld', 'test-household-budget-overlay-spent-drilldown.js'],
  ['Household Budget Spent shows a deliberately marked item: note, bounded and display-only', 'test-displayed-item-note.js'],
  ['header freshness source identity (history vs live overlay spending)', 'test-header-freshness-source-identity.js'],
  ['Household Budget Spent possible-replacement drill-down', 'test-household-budget-spent-possible-replacement-drilldown.js'],
  ['current-period Household Budget classification', 'test-current-period-household-budget-classification.js'],
  ['cancelled-service unexpected charge', 'test-cancelled-service-unexpected-charge.js'],
  ['Lunch Money Dale/Amanda guilt-free category assignment', 'test-lunchmoney-dale-amanda-guilt-free.js'],
  ['BC Hydro Sep 4 Other-spending classification', 'test-bc-hydro-sep4-classification.js'],
  ['Bell Mobility Travel Visa Other-spending classification', 'test-bell-travelvisa-classification.js'],
  ['Bell Sep 15 2026 same-account BILLS split settlement', 'test-bell-same-account-split.js'],
  ['Bell standing BILLS two-leg settlement', 'test-bell-standing-bills-split.js'],
  ['BC Hydro equal monthly payment $199 due day (30th, estimated) and account credit', 'test-hydro-equal-payment.js'],
  ['N1 cash balance evidence date: semantic balance date wins, invalid is unknown', 'test-cash-balance-evidence-date.js'],
  ['G1a occurrence-scoped amount change lands only in its own occurrence; missing reads Unknown; live Hydro due day', 'test-bill-regular-change-boundary.js'],
  ['C2/N3 coverage authority (Forecast): unestablished coverage withholds remainder, future costs and liquidity', 'test-coverage-forecast-withhold.js'],
  ['C1/N2 coverage authority (observer): a dropped household row or a failed account sync marks coverage incomplete', 'test-coverage-observer-stamp.js'],
  ['A1/A2 coverage authority (observer): the stamp reads complete only on positive evidence', 'test-coverage-positive-evidence.js'],
  ['observation-memory projection keeps the account sync fields so replay equals the live evaluation', 'test-observation-memory-sync-fields.js'],
  ['Fortis confirmed October no-pay requirement', 'test-fortis-annual-review.js'],
  ['Rehearsal-space monthly estimated timing and no October replay', 'test-rehearsal-space-bill.js'],
  ['standing Fortis / Shaw / Netflix / TD / YouTube / Spotify / ChatGPT Plus Dale / ChatGPT Plus Amanda / iCloud settlement identities', 'test-bill-settlement-identities.js'],
  ['guarded posted Shaw identity and one-cost Bills/Other conservation', 'test-shaw-posted-identity.js'],
  ['calendar / Budget bills reprint representedActuals as Paid', 'test-calendar-represented-actuals-paid.js'],
  ['unresolved pending→posted household-spend treatment', 'test-unresolved-pending-posted-spend.js'],
  ['current-period Other-residual classification contract', 'test-current-period-other-residual-contract.js'],
  ['salary recognition and payroll drift', 'test-salary-recognition-drift.js'],
  ['owner income-recognition policy 2026-09-11', 'test-income-recognition-owner-policy.js'],
  ['Canada Child Benefit amount $219.45', 'test-child-benefit-amount.js'],
  ['Canada Child Benefit privacy-stripped overlay match', 'test-child-benefit-overlay-match.js'],
  ['Other Income payday waterfall', 'test-other-income.js'],
  ['proven household-internal cash movement', 'test-household-internal-movement.js'],
  ['leftover vs Current Balance operating-cash explanation', 'test-leftover-operating-cash-explanation.js'],
  ['leftover vs BILLS ACCOUNT cash explanation', 'test-leftover-bills-cash-explanation.js'],
  ['configured purpose-reserve transfer recognition', 'test-purpose-reserve-transfers.js'],
  ['payday-boundary chequing-a posted cash observation', 'test-payday-boundary-bills-observation.js'],
  ['payday-boundary chequing-a observation persist', 'test-payday-boundary-observation-persist.js'],
  ['posted chequing-a movement evidence set', 'test-chequing-a-posted-movements.js'],
  ['operating-cash explanation after Q07 after budget polish', 'test-operating-cash-explanation-placement.js'],
  ['Plan payday operating periods', 'test-payday-operating-periods.js'],
  ['Sep 10 to Sep 11 payday rollover boundary', 'test-payday-rollover-boundary.js'],
  ['Plan payday waterfall balance date and post-payday identity', 'test-plan-payday-waterfall-balance.js'],
  ['owner-policy Payday balance waterfall', 'test-payday-balance-owner-policy.js'],
  ['payday snapshot vs live Current Balance', 'test-payday-snapshot-live-balance.js'],
  ['payday opening authority from dated opening', 'test-payday-opening-authority.js'],
  ['payday waterfall bill load vs remaining-only leftover', 'test-payday-waterfall-bill-load.js'],
  ['A6 unknown bill amount or date stays unknown (#726)', 'test-a6-unknown-bill-amount-date.js'],
  ['payday settlement survives live opening advancement', 'test-payday-settlement-boundary.js'],
  ['payday Household Budget max(planned, actual) contract', 'test-household-budget-waterfall-contract.js'],
  ['current-pay-period Balance After Deductions (owner 2026-09-21)', 'test-predicted-ending-balance.js'],
  ['hub-account Current Balance and Balance After Deductions', 'test-hub-account-balance-after-deductions.js'],

  ['Plan unavailable operating state', 'test-plan-unavailable-surface.js'],
  ['Plan next-period lookahead and week picker', 'test-plan-lookahead-week.js'],
  ['Plan completed historical pay periods', 'test-historical-pay-periods.js'],
  ['Budget timeline pay-period sequence', 'test-budget-timeline-pay-periods.js'],
  ['#723 gap 5 sealed-lookback unknown receipt', 'test-forecast-723-gap5-repro.js'],
  ['Budget pay-period swipe navigation', 'test-budget-pay-period-swipe.js'],
  ['Budget synchronized month and pay-period wheels', 'test-budget-synchronized-wheels.js'],
  ['Budget stepped period layout and inline disclosures', 'test-budget-stepped-layout.js'],
  ['Planned Savings compact status and evidence', 'test-planned-savings-clarity.js'],
  ['Savings exact category/tag attribution foundation', 'test-savings-link-foundation.js'],
  ['Enabled Savings attribution preserves G1 capture grammar', 'test-savings-link-capture.js'],
  ['Savings item ledger: signed attribution, edge cases, traps and live effects (A4a, A4b)', 'test-savings-item-ledger.js'],
  ['A4b: item routing and backing (check 2 and 3, Savings vs chequing, split/pair, owner overlap, reload)', 'test-savings-a4b-routing.js'],
  ['combined observed savings stock and unchanged deductions', 'test-savings-observed-stock.js'],
  ['Budget selected-period proposed cost funding', 'test-budget-period-funding.js'],
  ['Budget backing-aware remaining gaps and unknown/actual conservation', 'test-budget-funding-backing-gaps.js'],
  ['Budget estimated payroll trust label', 'test-budget-estimated-payroll-label.js'],
  ['Budget Plan Spend earmark on pay periods', 'test-budget-plan-spend-earmark.js'],
  ['Plan Spend mixed-source current-payday reconciliation', 'test-plan-spend-mixed-reconciliation.js'],
  ['Payday instruction shell (AMANDA slice 1)', 'test-payday-instruction-shell.js'],
  ['Budget Month <-> Pay Period view (AMANDA slice 3)', 'test-budget-month-view.js'],
  ['Planned-spending funding status (AMANDA slice 4)', 'test-planned-spending-funding-status.js'],
  ['Upcoming funding pressure (AMANDA slice 5)', 'test-upcoming-funding-pressure.js'],
  ['Focus debt continuity (AMANDA slice 6)', 'test-focus-debt-continuity.js'],
  ['Monthly funding pressure detail (AMANDA slice 8)', 'test-budget-month-funding-pressure.js'],
  ['Same-month pay-period drilldown (AMANDA slice 9)', 'test-budget-month-pay-period-drilldown.js'],
  ['Selected pay-period money map (AMANDA slice 10)', 'test-budget-month-pay-period-money-map.js'],
  ['Selected pay-period funding plan (AMANDA slice 11)', 'test-budget-month-pay-period-funding-plan.js'],
  ['Selected pay-period funding shortfall (AMANDA slice 12)', 'test-budget-month-pay-period-funding-shortfall.js'],
  ['Extra-debt target attribution, engine (AMANDA slice 13)', 'test-forecast-extra-debt-attribution.js'],
  ['Selected pay-period debt target attribution (AMANDA slice 13)', 'test-budget-month-pay-period-debt-target.js'],
  ['Plan payday carryover trend', 'test-payday-carryover-trend.js'],
  ['Plan actual vs budget digest', 'test-plan-budget-digest.js'],
  ['weekly cap conversion + discretionary room', 'test-weekly-cap.js'],
  ['food and fuel monthly figures', 'test-food-fuel.js'],
  ['phase titles and risk list', 'test-plan-phases.js'],
  ['Deep Dive derived totals', 'test-deepdive.js'],
  ['HELOC Deep Dive current-opening agreement (B19)', 'test-heloc-deepdive.js'],
  ['coupled cash and debt', 'test-debt.js'],
  ['debt absorption covers the cash horizon', 'test-debt-absorption-horizon.js'],
  ['amortising payoff stops later interest share', 'test-amortizing-payoff-horizon.js'],
  ['live recurring debt and cash horizon reconciliation', 'test-live-debt-horizon.js'],
  ['HELOC crossing-date authority', 'test-heloc-crossing-authority.js'],
  ['HELOC Forecast Required-debt cash minimum', 'test-heloc-forecast-cash-minimum.js'],
  ['authority invariants', 'test-invariants.js'],
  ['authority surface coverage', 'test-authority-coverage.js'],
  ['evidence-use register routing', 'test-evidence-use-register.js'],
  ['knowledge-evidence register (external-reference)', 'test-knowledge-evidence-register.js'],
  ['live household reconciliation', 'test-live-household.js'],
  ['duplicate live-fact cleanup (B93)', 'test-dedup-facts.js'],
  ['current-balance conclusions are Forecast-derived', 'test-derive-current-headroom.js'],
  ['refresh isolation subprocess diagnostics and bounded deadlines', 'test-refresh-isolation-runner.js'],
  ['refresh isolation (B92)', 'test-refresh-isolation.js'],
  ['non-writing reconciliation (B91)', 'test-reconcile.js'],
  ['current-state cutover (B91)', 'test-cutover.js'],
  ['unresolved once obligations survive cutover', 'test-cutover-unresolved.js'],
  ['commitment settlement (B91 D3)', 'test-settlement.js'],
  ['settled commitment not carried through priorAsOf', 'test-settled-commitment-priorasof.js'],
  ['Hydro dated obligation (B91 D4+D5)', 'test-hydro.js'],
  ['Amanda income split (B91 D2)', 'test-amanda-income.js'],
  ['card current state (B91 D8)', 'test-card-state.js'],
  ['schedule vs posted (B91 D7)', 'test-posting.js'],
  ['near-boundary payday output (B91 D11)', 'test-near-boundary.js'],
  ['B91 live current-state cutover', 'test-b91-cutover.js'],
  ['merge-card check behaviour', 'test-mergecard.js'],
  ['figures comment Plan/Credit/Planning scope (B82/B100)', 'test-figures-comment.js'],
  ['figures snapshot Credit and Planning coverage (B100)', 'test-figures-snapshot-credit-planning.js'],
  ['figures check: invented inputs, declared field-class coverage and INCOMPLETE (G1)', 'test-figures-coverage.js'],
  ['figures check: Savings selector consumer contract and page-vs-collector behavior (G1 reassessment A)', 'test-savings-consumer-contract.js'],
  ['Savings guard pin generator: per-entry diff and write (tiny invented tree)', 'test-savings-guard-pins.js'],
  ['figures check: Savings capture fidelity against lossless originals, mutation verdict table, reference attacks, S1-S4 (G1 adopted design)', 'test-savings-capture-fidelity.js'],
  ['figures check: Savings per-state call roster, gate facts, the pre-review regression witnesses and the finite-repair witnesses through both validators (G1 table r4/r4.1, rules v5)', 'test-savings-capture-roster.js'],
  ['Trusted repair privacy gate and private artifact hold', 'test-ci-repair-privacy.js'],
  ['Atlas review-block card sync', 'test-atlas-review-block.js'],
  ['Atlas bounded re-review handoff', 'test-atlas-api-rereview.js'],
  ['Atlas manual REQUIRED review handoff', 'test-atlas-first-review.js'],
  ['Merge Card primary-risk projection', 'test-atlas-primary-risk.js'],
  ['GitHub PR-head confirmation after push', 'test-github-pr-head-sync.js'],
  ['local main sync safety contract', 'test-sync-main.js'],
  ['read-only provider observation (connectivity spike)', 'test-provider-observe.js'],
  ['local Lunch Money credential resolver', 'test-local-credentials.js'],
  ['live pending observations (B91 / B78)', 'test-pending-observe.js'],
  ['idempotent Lunch Money identity (B78 / AF-INGEST-01)', 'test-b78-identity.js'],
  ['trusted canonical refresh (B81 / AF-LIVE-02)', 'test-b81-refresh.js'],
  ['opening-cutover preflight (B81 read-only)', 'test-cutover-preflight.js'],
  ['bounded cutover pending writer (B81)', 'test-b81-pending-writer.js'],
  ['bounded opening-cutover writer (B81)', 'test-b81-opening-cutover.js'],
  ['opening state transition (B81)', 'test-b81-opening-state.js'],
  ['opening artifact recovery (B81)', 'test-b81-opening-recovery.js'],
  ['live plan overlay without rewriting openings', 'test-live-plan.js'],
  ['request-scoped exact-input refresh evaluation reuse', 'test-refresh-evaluation-reuse.js'],
  ['closed refresh stage timings with unchanged worker results', 'test-refresh-stage-timing.js'],
  ['current-period Savings planning and exact-once observed replacement', 'test-savings-current-period-projection.js'],
  ['live overlay unresolved same-day inbound', 'test-live-unresolved-inbound.js'],
  ['production read-only live overlay boundary', 'test-production-live-overlay.js'],
  ['legacy /planning.html retired to Budget at / (redirect, HTTP variants, auth preserved)', 'test-planning-retirement.js'],
  ['read-only assistant interface', 'test-assistant-interface.js'],
  ['Aug. 16 household evidence absorption', 'test-aug16-evidence.js'],
  ['2026-09-03 card-charge evidence intake', 'test-card-charge-evidence-2026-09-03.js'],
  ['telecom current-regime closeout', 'test-telecom-current-regime.js'],
  ['Bell card-paid baseline gravity', 'test-bell-card-paid.js'],
  ['Bell dated mid-month planning', 'test-bell-dated-planning.js'],
  ['Bell Sep 2026 once $283.94 and standing $160 from Oct', 'test-bell-sep15-2026.js'],
  ['Square One yearly card-paid home insurance', 'test-square-one-annual-bill.js'],
  ['HELOC Q19 + Bell Q18 evidence closeout', 'test-q19-q18-closeout.js'],
  ['Q1 planning policy (2026-08-29 coaching gravy)', 'test-q1-planning-policy.js'],
  ['major future costs on the master plan', 'test-major-future-costs.js'],
  ['commitment month-only day-15 dating', 'test-commitment-month-day15.js'],
  ['Fusion household + Warriors U13 plan commitments', 'test-fusion-warriors-plan-commitments.js'],
  ['Warriors U13 $895 settlement identity', 'test-warriors-u13-settlement.js'],
  ['master forecast engine (B94 / AF-PLAN-01)', 'test-master-forecast.js'],
  ['end-to-end payday proof (B96 / AF-PLAN-02)', 'test-b96-payday.js'],
  ['payday allocation waterfall', 'test-payday-allocation.js'],
  ['Prepare Ahead is paydayAllocation.protectedPath', 'test-prepare-ahead.js'],
  ['payday Household Budget cash identity', 'test-payday-household-cash-identity.js'],
  ['payday reserve itemization', 'test-payday-reserve-detail.js'],
  ['current-period actuals action plan', 'test-current-period-actuals.js'],
  ['this-payday already-paid set and cancelled CMAW drop', 'test-this-payday-already-paid.js'],
  ['automatic-payment settlement reconciliation', 'test-automatic-payment-settlement.js'],
  ['Triangle and MBNA card-minimum settlement', 'test-card-minimum-settlement.js'],
  ['owner-authorized minimum category confirmation', 'test-card-minimum-category.js'],
  ['TD / Cash Back / Travel Visa PAYMENT - THANK YOU card-minimum identity', 'test-payment-thank-you-card-minimum.js'],
  ['Emerald owner-confirmed original October minimum', 'test-emerald-october-minimum.js'],
  ['card minimum occurrence history and early-paid publication', 'test-card-minimum-occurrence-boundaries.js'],
  ['purchase backfills cannot confirm scheduled card minima', 'test-card-backfill-intent.js'],
  ['month-end bill settlement and unmatched fee visibility', 'test-month-end-bill-reconciliation.js'],
  ['Dale-gated Noble / HELOC / TDCC represented settles', 'test-dale-gated-represented-settles.js'],
  ['represented settlement effective-date cash conservation', 'test-represented-effective-date.js'],
  ['Noble pending→posted identity survives replacement', 'test-noble-pending-posted-identity.js'],
  ['owner-confirmed September fuel, Spotify, and Noble rows', 'test-owner-confirmed-september-spend.js'],
  ['fuel classification owner rules (Dale 2026-10-14)', 'test-fuel-classification-owner-rules.js'],
  ['final Affirm payment owner correction', 'test-affirm-final.js'],
  ['retire cancelled CMAW union-dues recurrence (AF-REFRESH-01)', 'test-refresh-01-union-dues.js'],
  ['on-demand observation receipt (AF-REFRESH-02)', 'test-refresh-02-observation-receipt.js'],
  ['obligation reconciliation receipt (AF-REFRESH-03)', 'test-refresh-03-obligation-reconciliation.js'],
  ['bounded canonical refresh preview (AF-REFRESH-04)', 'test-refresh-04-canonical-preview.js'],
  ['recompute operating answer from refreshed state (AF-REFRESH-05)', 'test-refresh-05-operating-answer.js'],
  ['refresh trust on the operating surface (AF-REFRESH-06)', 'test-refresh-06-trust-surface.js'],
  ['live closed-loop acceptance and cleanup (AF-REFRESH-07)', 'test-refresh-07-live-acceptance.js'],
  ['balance history as a refresh by-product (B20 / AF-HIST-01)', 'test-b20-history.js'],
  ['current spendable copy and recorded cash membership', 'test-recorded-cash-labels.js'],
];


// One ordered manifest owns both the serial reference and the two CI groups.
// Do not glob: probe-savings-daily-allocation-incumbent.js is also a suite.
const ISOLATION_SUITE = 'test-refresh-isolation.js';
const GROUPS = Object.freeze(['standard', 'refresh-isolation']);
for (const suite of suites) Object.freeze(suite);
Object.freeze(suites);

function validateSuites(manifest) {
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error('A suite selection must be nonempty');
  }
  const files = new Set();
  for (const row of manifest) {
    if (!Array.isArray(row) || row.length !== 2 ||
        typeof row[0] !== 'string' || !row[0].trim() ||
        typeof row[1] !== 'string' || !/^[a-z0-9-]+\.js$/.test(row[1])) {
      throw new Error('Invalid suite manifest entry');
    }
    if (files.has(row[1])) throw new Error(`Duplicate suite: ${row[1]}`);
    files.add(row[1]);
  }
}

function selectSuites(group = 'all', manifest = suites) {
  if (group !== 'all' && !GROUPS.includes(group)) {
    throw new Error(`Unknown suite group: ${group}`);
  }
  validateSuites(manifest);
  if (!manifest.some(([, file]) => file === ISOLATION_SUITE)) {
    throw new Error('The manifest must include the refresh-isolation suite');
  }
  const selected = manifest.filter(([, file]) => group === 'all' ||
    (group === 'refresh-isolation' ? file === ISOLATION_SUITE : file !== ISOLATION_SUITE));
  validateSuites(selected);
  return selected;
}

function selectionFromArgs(args) {
  if (args.length === 0) return selectSuites();
  if (args.length !== 2 || args[0] !== '--group') {
    throw new Error('Usage: node test/test.js [--group standard|refresh-isolation|all]');
  }
  return selectSuites(args[1]);
}

// Synchronous execution is deliberate: suites mutate shared checkout files.
// The injected operations let the runner's failure contract be tested without
// launching financial suites or changing their assertion/cleanup semantics.
function runSuites(suites, { execute = execFileSync, exists = fs.existsSync,
  log = console.log, publicCI = CiOutput.publicMode() } = {}) {
  validateSuites(suites);
  const failed = [];
  let suiteOrdinal = 0;
  for (const [name, file] of suites) {
    const identity = CiOutput.suiteIdentity(file, ++suiteOrdinal);
    if (publicCI && identity.startsWith('suite-')) {
      CiOutput.publish({ identity, status: 'fail', category: 'invalid-configuration',
        exitCode: 1, signal: null, executed: false });
      failed.push(identity);
      continue;
    }
    if (!exists(path.join(__dirname, file))) {
      if (publicCI) {
        CiOutput.publish({ identity, status: 'fail', category: 'missing-suite',
          exitCode: 1, signal: null, executed: false });
        failed.push(file);
        continue;
      }
      log(`\n\x1b[31m✗\x1b[0m ${name} — ${file} is missing`);
      failed.push(name);
      continue;
    }
    if (publicCI) {
      CiOutput.startSuite(identity);
      const result = CiOutput.runCaptured(process.execPath, [path.join(__dirname, file)],
        { cwd: ROOT, identity: file });
      CiOutput.publish(result);
      if (result.status !== 'pass') failed.push(file);
      continue;
    }
    log(`\n\x1b[1m──────── ${name} ────────\x1b[0m`);
    try {
      execute(process.execPath, [path.join(__dirname, file)], { cwd: ROOT, stdio: 'inherit' });
    } catch {
      failed.push(name);
    }
  }

  if (publicCI) {
    log(JSON.stringify({ type: 'ci-suite-summary', total: suites.length,
      passed: suites.length - failed.length, failed: failed.length,
      failedSuites: failed, exitCode: failed.length ? 1 : 0 }));
    return failed.length ? 1 : 0;
  }
  log('\n' + '═'.repeat(60));
  if (failed.length) {
    log(`\x1b[31mFAILED\x1b[0m — ${failed.length} of ${suites.length} suites: ${failed.join(', ')}`);
    return 1;
  }
  log(`\x1b[32mALL ${suites.length} SUITES PASSED\x1b[0m`);
  return 0;
}

// Optional bounded concurrency for the hosted CI record mode only. The serial
// reference above is untouched and remains `npm test`. Same suites, same
// processes, same per-suite capture: each suite still runs through
// scripts/ci-output.js, which keeps its streams in private files and reports
// one closed outcome record. Only the scheduling differs, and the public
// records are still emitted one suite at a time in manifest order, so the
// downstream record validator sees exactly the serial protocol.
//
// Start order is a hint, never a result: the slowest known suites start first
// so the wall clock is not set by one of them starting last.
const START_FIRST = Object.freeze([
  'test-figures-coverage.js', 'test-savings-consumer-contract.js',
  'test-savings-capture-roster.js', 'test-figures-snapshot-credit-planning.js',
  'test-live-plan.js', 'test-nextmove.js', 'test-settlement-evidence-confirmation.js',
]);
// Suites that rewrite shared checkout state (found by tracing every suite's
// file writes): they run alone, before the pool starts, never beside another suite.
//  - test-running-build.js replaces the checkout's gitignored .atlas-build.json,
//    which every server.js started from the checkout reads.
//  - test-talk-context.js fetches over a keep-alive socket and then builds the
//    incumbent packet in-process; with other suites competing for CPU that step
//    can outlast the server's 5s keep-alive timeout, so the next request fails
//    with "other side closed" (reproduced locally under 4-way load, and once on
//    the first hosted run). Its assertions are sound; it needs an unloaded CPU.
const RUN_ALONE_FIRST = Object.freeze(['test-running-build.js', 'test-talk-context.js']);
const MAX_JOBS = 16;

function jobsFromArgs(args) {
  if (args.length >= 2 && args[args.length - 2] === '--jobs') {
    if (!/^[1-9][0-9]?$/.test(args[args.length - 1]) || Number(args[args.length - 1]) > MAX_JOBS) {
      throw new Error('Usage: --jobs takes an integer from 1 to ' + MAX_JOBS);
    }
    return { jobs: Number(args[args.length - 1]), rest: args.slice(0, -2) };
  }
  return { jobs: 1, rest: args };
}

function spawnOutcomeWorker(file) {
  const { spawn } = require('child_process');
  return new Promise(resolve => {
    let out = '';
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/ci-output.js'),
      '--identity', file, '--cwd', ROOT, '--', process.execPath, path.join(__dirname, file)],
    { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    // The long CPU-bound suites run at lower priority so they cannot starve the
    // short server-starting suites, which have fixed start and keep-alive
    // timeouts. Children inherit it; the suites are still all run, to completion.
    if (START_FIRST.includes(file)) { try { os.setPriority(child.pid, 10); } catch { /* best effort */ } }
    child.stdout.on('data', chunk => { if (out.length < 65536) out += chunk; });
    child.on('error', () => resolve({ out: '', code: null, signal: null }));
    child.on('close', (code, signal) => resolve({ out, code, signal }));
  });
}

// The worker's only stdout is the one outcome record scripts/ci-output.js
// publishes. Rebuild the record through CiOutput.publish's closed schema, and
// never trust a pass that the worker's own exit status contradicts.
function outcomeFromWorker(file, { out, code, signal }) {
  const failed = { identity: file, status: 'fail', category: 'capture-failed',
    exitCode: 1, signal: null, executed: false };
  const lines = out.split('\n').filter(Boolean);
  if (lines.length !== 1) return failed;
  let record;
  try { record = JSON.parse(lines[0]); } catch { return failed; }
  if (!record || record.type !== 'ci-outcome' || record.identity !== file) return failed;
  const result = { identity: file, status: record.status, category: record.category,
    exitCode: record.exitCode, signal: record.signal, executed: record.executed,
    syntheticProofVerified: record.syntheticProof ===
      'stdout-stderr-annotations-formatter-and-exit-canaries' };
  if (record.status === 'pass' && (code !== 0 || signal)) return failed;
  return result;
}

async function runSuitesPooled(suites, { jobs, exists = fs.existsSync, log = console.log,
  work = spawnOutcomeWorker } = {}) {
  validateSuites(suites);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > MAX_JOBS) throw new Error('Invalid job count');
  const plan = suites.map(([, file], index) => {
    const identity = CiOutput.suiteIdentity(file, index + 1);
    if (identity.startsWith('suite-')) return { file, identity, early: { identity, status: 'fail',
      category: 'invalid-configuration', exitCode: 1, signal: null, executed: false } };
    if (!exists(path.join(__dirname, file))) return { file, identity, early: { identity,
      status: 'fail', category: 'missing-suite', exitCode: 1, signal: null, executed: false } };
    return { file, identity, early: null };
  });
  // Bounded pool: at most `jobs` suite processes in flight, hinted suites first.
  const rank = file => { const i = START_FIRST.indexOf(file); return i < 0 ? START_FIRST.length : i; };
  const order = plan.map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry.file) - rank(b.entry.file) || a.index - b.index);
  const done = plan.map(() => null);
  const waiters = plan.map(() => null);
  const finished = plan.map((_, i) => new Promise(resolve => { waiters[i] = resolve; }));
  async function execute({ entry, index }) {
    if (entry.early) { done[index] = entry.early; waiters[index](); return; }
    let result;
    try { result = outcomeFromWorker(entry.file, await work(entry.file)); }
    catch { result = outcomeFromWorker(entry.file, { out: '', code: null, signal: null }); }
    done[index] = result;
    waiters[index]();
  }
  const alone = order.filter(({ entry }) => RUN_ALONE_FIRST.includes(entry.file));
  const pooled = order.filter(({ entry }) => !RUN_ALONE_FIRST.includes(entry.file));
  let cursor = 0;
  async function lane() {
    while (cursor < pooled.length) await execute(pooled[cursor++]);
  }
  const scheduling = (async () => {
    for (const item of alone) await execute(item);
    await Promise.all(Array.from({ length: Math.min(jobs, pooled.length) }, lane));
  })();
  const failed = [];
  for (let i = 0; i < plan.length; i++) {
    const { file, early } = plan[i];
    if (!early) CiOutput.startSuite(plan[i].identity);
    await finished[i];
    CiOutput.publish(done[i]);
    if (done[i].status !== 'pass') failed.push(file);
  }
  await scheduling;
  log(JSON.stringify({ type: 'ci-suite-summary', total: suites.length,
    passed: suites.length - failed.length, failed: failed.length,
    failedSuites: failed, exitCode: failed.length ? 1 : 0 }));
  return failed.length ? 1 : 0;
}

if (require.main === module) {
  if (CiOutput.publicMode()) {
    // Let the installed privacy boundary handle selection/runner exceptions.
    // Catching and printing their raw message here would bypass that boundary.
    const { jobs, rest } = jobsFromArgs(process.argv.slice(2));
    const selection = selectionFromArgs(rest);
    if (jobs > 1) {
      runSuitesPooled(selection, { jobs }).then(code => { process.exitCode = code; });
    } else process.exitCode = runSuites(selection);
  } else try {
    const { jobs, rest } = jobsFromArgs(process.argv.slice(2));
    if (jobs > 1) throw new Error('--jobs requires the hosted CI record mode');
    process.exitCode = runSuites(selectionFromArgs(rest));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { suites, GROUPS, selectSuites, selectionFromArgs, runSuites,
  jobsFromArgs, runSuitesPooled, outcomeFromWorker, RUN_ALONE_FIRST };
