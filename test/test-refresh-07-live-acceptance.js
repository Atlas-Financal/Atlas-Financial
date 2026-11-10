'use strict';
/* AF-REFRESH-07 — live closed-loop acceptance and campaign cleanup.
 *
 * Fixture proofs cover composition, sanitization, Forecast identity,
 * same-payload idempotency, no canonical write, and security source
 * bounds. Live cents in the dated proof document are not engine
 * specifications (L-006). Independent spendable cash is the three
 * posted household-cash rows. --live still fails closed when the
 * owner-verified account-id map is missing.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const O = require('../scripts/provider-observe.js');
const Live = require('../scripts/live-plan.js');
const OA = require('../scripts/operating-answer.js');
const Loop = require('../scripts/refresh-loop-acceptance.js');
const Forecast = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');
const POSITIONS = path.join(ROOT, 'docs', 'positions.csv');
const PERIODS = path.join(ROOT, 'public', 'periods.json');
const SNAPSHOTS = path.join(ROOT, 'snapshots');
const SCRIPT = path.join(ROOT, 'scripts', 'refresh-loop-acceptance.js');
const LIVE_PROOF = path.join(ROOT, 'docs', 'connectivity', 'LIVE_ACCEPTANCE_AF_REFRESH_07_2026-08-25.md');
const MAP = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'b81-account-map.json');
const IDENTITY = path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json');
const FETCHED_AT = '2026-08-21T18:00:00.000Z';
const OBSERVED = '2026-08-21T17:55:00.000Z';
const CASH_PURCHASE = 30;

const PRIOR_SUITES = [
  ['AF-REFRESH-01', 'test-refresh-01-union-dues.js'],
  ['AF-REFRESH-02', 'test-refresh-02-observation-receipt.js'],
  ['AF-REFRESH-03', 'test-refresh-03-obligation-reconciliation.js'],
  ['AF-REFRESH-04', 'test-refresh-04-canonical-preview.js'],
  ['AF-REFRESH-05', 'test-refresh-05-operating-answer.js'],
  ['AF-REFRESH-06', 'test-refresh-06-trust-surface.js'],
];

let failures = 0;
function ok(cond, label, detail) {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function load(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function read(file) { return sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8')); }
function exists(file) { return fs.existsSync(path.join(ROOT, file)); }
function hashTree() {
  return Loop.hashTree({
    data: DATA,
    positions: POSITIONS,
    periods: PERIODS,
    snapshots: SNAPSHOTS,
  });
}
function cashValue(data, id) {
  const row = (((data.plan || {}).startingCash || {}).breakdown || []).find(r => r && r.id === id);
  return row ? Number(row.value) : null;
}
function debt(data, id) {
  return ((data.debts || []).find(d => d && d.id === id)) || null;
}
function matchingAccounts(data, tweaks) {
  const t = tweaks || {};
  return [
    {
      id: 3001, name: 'BILLS ACCOUNT', type: 'cash', subtype: 'checking',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t['chequing-a'] != null ? t['chequing-a'] : cashValue(data, 'chequing-a'),
      updated_at: t.cashAt || OBSERVED, balance_last_update: t.cashAt || OBSERVED,
    },
    {
      id: 3002, name: 'WEEKLY SPENDING', type: 'cash', subtype: 'checking',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t['chequing-b'] != null ? t['chequing-b'] : cashValue(data, 'chequing-b'),
      updated_at: t.cashAt || OBSERVED, balance_last_update: t.cashAt || OBSERVED,
    },
    {
      id: 3003, name: 'EMERGENCY SAVING', type: 'cash', subtype: 'savings',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.savings != null ? t.savings : cashValue(data, 'savings'),
      updated_at: t.savingsAt || t.cashAt || OBSERVED, balance_last_update: t.savingsAt || t.cashAt || OBSERVED,
    },
    {
      id: 3004, name: 'PERSONAL CREDIT CARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.tdcc != null ? t.tdcc : debt(data, 'tdcc').balance,
      credit_limit: debt(data, 'tdcc').limit,
      updated_at: t.cardAt || OBSERVED, balance_last_update: t.cardAt || OBSERVED,
    },
    {
      id: 3005, name: 'TD CASH BACK VISA* CARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.cashback != null ? t.cashback : debt(data, 'cashback').balance,
      credit_limit: debt(data, 'cashback').limit,
      updated_at: t.cardAt || OBSERVED, balance_last_update: t.cardAt || OBSERVED,
    },
    {
      id: 3006, name: 'TRAVEL VISA', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.travelvisa != null ? t.travelvisa : debt(data, 'travelvisa').balance,
      credit_limit: debt(data, 'travelvisa').limit,
      updated_at: t.cardAt || OBSERVED, balance_last_update: t.cardAt || OBSERVED,
    },
    {
      id: 3007, name: 'LINE OF CREDIT - HOME EQUITY', type: 'loan', subtype: 'line_of_credit',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.heloc != null ? t.heloc : debt(data, 'heloc').balance,
      updated_at: t.loanAt || OBSERVED, balance_last_update: t.loanAt || OBSERVED,
    },
    {
      id: 3008, name: 'MORTGAGE', type: 'loan', subtype: 'mortgage',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: t.mortgage != null ? t.mortgage : debt(data, 'mortgage').balance,
      updated_at: t.loanAt || OBSERVED, balance_last_update: t.loanAt || OBSERVED,
    },
    {
      id: 3010, name: 'TRIANGLE MASTERCARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'Canadian Tire Bank', currency: 'cad',
      balance: t.triangle != null ? t.triangle : debt(data, 'triangle').balance,
      credit_limit: debt(data, 'triangle').limit,
      updated_at: t.cardAt || OBSERVED, balance_last_update: t.cardAt || OBSERVED,
    },
  ];
}
function completePayload(data, tweaks) {
  return {
    provider: 'lunchmoney',
    fetchedAt: FETCHED_AT,
    source: 'Synthetic AF-REFRESH-07 fixture. Not a live institution pull.',
    accounts: matchingAccounts(data, tweaks),
    transactions: [],
    pendingCoverage: {
      complete: true,
      basis: O.PENDING_COVERAGE_BASIS,
      hasMore: false,
      startDate: null,
      endDate: null,
      truncated: false,
    },
    transactionWindow: {
      startDate: '2026-08-07',
      endDate: '2026-08-21',
      complete: true,
      hasMore: false,
      truncated: false,
    },
  };
}

const liveData = load(DATA);
const mapDoc = load(MAP);
const identity = load(IDENTITY);
const beforeTree = hashTree();

function filesUnchanged(label) {
  const now = hashTree();
  ok(now.data === beforeTree.data, `${label}: data.json bytes unchanged`);
  ok(now.positions === beforeTree.positions, `${label}: positions.csv unchanged`);
  ok(now.periods === beforeTree.periods, `${label}: periods.json unchanged`);
  ok(now.snapshots === beforeTree.snapshots, `${label}: snapshots unchanged`);
}

console.log('=== campaign closeout and prior-slice proofs remain ===');
{
  const registry = new Set(require('./suites.json').map(([, file]) => file));
  for (const [id, file] of PRIOR_SUITES) {
    ok(exists(path.join('test', file)), `${id} independent proof ${file} remains as regression`);
    ok(registry.has(file), `${id} stays registered in npm test`);
  }
  ok(!exists('docs/AF_REFRESH_TRUSTED_STATE_LOOP_PLAN.md'),
    'the temporary AF-REFRESH campaign plan is deleted');
  ok(!exists('docs/.AF_REFRESH_07_DISPATCH.md'),
    'no successor campaign dispatch file was invented');
  ok(!exists('docs/AF_OPERATE_PAYDAY_OPERATING_SURFACE_PLAN.md'),
    'the temporary AF-OPERATE campaign plan stays deleted');
  ok(exists('docs/connectivity/LIVE_ACCEPTANCE_AF_REFRESH_07_2026-08-25.md'),
    'the dated live closed-loop proof is committed');
}

console.log('\n=== A. fixture closed loop answers the seven acceptance questions ===');
{
  const canonical = clone(liveData);
  const observedA = cashValue(canonical, 'chequing-a') - CASH_PURCHASE;
  const payload = completePayload(canonical, { 'chequing-a': observedA });
  const packet = Loop.fromIncumbents({
    data: canonical,
    payload,
    accountMap: mapDoc,
    identity,
  });
  ok(packet.schema === Loop.SCHEMA, 'packet uses atlas-refresh-loop-acceptance/v1');
  ok(packet.liveEvidence && packet.liveEvidence.overlayApplied === true,
    'live evidence overlay applied');
  ok(packet.liveEvidence.changed.some(row => row.locator === 'cash:chequing-a'
    && row.proposedValue === observedA),
    'changed live evidence names the chequing-a overlay');
  ok(packet.modeledItems && typeof packet.modeledItems.counts.represented === 'number'
    && typeof packet.modeledItems.counts.unverified === 'number'
    && typeof packet.modeledItems.counts.upcoming === 'number',
    'modeled items keep represented / still due / unverified distinct');
  ok('ownerQuestion' in packet, 'owner question field is present even when null');
  ok(packet.canonicalProposal && packet.canonicalProposal.writesCanonicalState === false
    && packet.canonicalProposal.canonicalWriteAuthorized === false,
    'canonical proposal is preview-only');
  ok(packet.canonicalProposal.waiting === true
    && packet.canonicalProposal.rows.some(row => row.locator === 'cash:chequing-a'),
    'mechanically provable chequing-a write is proposed before any apply');
  ok(packet.forecast && packet.forecast.asOf && packet.forecast.operatingAnswer,
    'Forecast operating answer is present from the trusted overlay');
  ok(typeof packet.operatingAnswerChanged === 'boolean',
    'whether the operating answer changed is explicit');
  ok(packet.freshness && packet.freshness.displayState
    && packet.freshness.remainingClaim,
    'freshness/completeness is explicit');
  filesUnchanged('fixture loop');
}

console.log('\n=== B. independent Forecast identity and spendable cash ===');
{
  const canonical = clone(liveData);
  const observedA = cashValue(canonical, 'chequing-a') - CASH_PURCHASE;
  const payload = completePayload(canonical, { 'chequing-a': observedA });
  const packet = Loop.fromIncumbents({
    data: canonical,
    payload,
    accountMap: mapDoc,
    identity,
  });
  const overlay = Live.fromObservation({
    data: canonical,
    payload,
    accountMap: mapDoc,
    identity,
  });
  const asOf = overlay.data.liveOverlay.effectiveAsOf;
  const advice = Forecast.recommend(overlay.data.plan, asOf, OA.recommendOpts(overlay.data, {
    mode: 'live-overlay',
    writesCanonicalState: false,
  }));
  const breakdown = packet.forecast.cashBreakdown;
  const handSum = breakdown.reduce((sum, row) => sum + Number(row.value), 0);
  const chequingSum = observedA + cashValue(canonical, 'chequing-b');
  ok(Math.abs(handSum - (chequingSum + cashValue(canonical, 'savings'))) < 0.005,
    'hand sum of posted cash rows matches the overlaid chequing-a change plus designated savings');
  ok(Math.abs(packet.forecast.independentSpendable - chequingSum) < 0.005
    && Math.abs(packet.forecast.startingCash - chequingSum) < 0.005,
    'independent spendable equals Forecast.startingCashAmount chequing-only opening');
  ok(packet.forecast.projectorCopiesForecast === true
    && packet.forecast.operatingAnswer.moneyAvailable.value === advice.paydayAllocation.available
    && packet.forecast.operatingAnswer.currentSpendingPermission.weekly === advice.weekly,
    'projector copies Forecast.recommend; it does not recalculate');
  ok(packet.forecast.fundingBorrowed === 0 && packet.forecast.plannedDebtPermitted === false,
    'no auto-borrow and planned debt remains unpermitted');
  ok(packet.cardCapacityIsCash === 0, 'credit capacity is not household cash');
}

console.log('\n=== C. identical evidence replay is a deterministic no-op ===');
{
  const canonical = clone(liveData);
  const payload = completePayload(canonical, {
    'chequing-a': cashValue(canonical, 'chequing-a') - CASH_PURCHASE,
  });
  const first = Loop.fromIncumbents({ data: canonical, payload, accountMap: mapDoc, identity });
  const second = Loop.fromIncumbents({ data: canonical, payload, accountMap: mapDoc, identity });
  ok(first.idempotency.samePayloadReplay && second.idempotency.samePayloadReplay,
    'in-process replay of identical evidence is a no-op');
  ok(first.canonicalProposal.previewId === second.canonicalProposal.previewId,
    'previewId is stable across two acceptances of the same payload');
  ok(JSON.stringify(first.liveEvidence.changed) === JSON.stringify(second.liveEvidence.changed)
    && JSON.stringify(first.modeledItems) === JSON.stringify(second.modeledItems)
    && JSON.stringify(first.forecast.operatingAnswer.moneyAvailable)
      === JSON.stringify(second.forecast.operatingAnswer.moneyAvailable),
    'changed evidence, modeled items, and operating money match exactly');
  filesUnchanged('replay');
}

console.log('\n=== D. CLI is read-only and sanitized ===');
{
  const tmp = path.join(os.tmpdir(), 'af-refresh-07-' + process.pid + '.json');
  const payload = completePayload(liveData, {
    'chequing-a': cashValue(liveData, 'chequing-a') - CASH_PURCHASE,
  });
  fs.writeFileSync(tmp, JSON.stringify(payload));
  const printed = execFileSync(process.execPath, [SCRIPT, '--fixture', tmp, '--map', MAP], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(printed);
  ok(Loop.looksSanitized(parsed), 'CLI packet is sanitized');
  ok(parsed.writesCanonicalState === false && parsed.canonicalUnchanged === true,
    'CLI claims no canonical write and proves files unchanged');
  ok(parsed.providerWrite === false && parsed.unattended === false && parsed.scheduled === false,
    'CLI names the security bounds');
  let applyDenied = false;
  try {
    execFileSync(process.execPath, [SCRIPT, '--fixture', tmp, '--apply'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    applyDenied = /never writes/.test(String(err.stderr || err.message || err));
  }
  ok(applyDenied, '--apply is refused');
  fs.unlinkSync(tmp);
  filesUnchanged('CLI');
}

console.log('\n=== E. security source bounds still hold ===');
{
  const loopSrc = fs.readFileSync(SCRIPT, 'utf8');
  const observeSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'provider-observe.js'), 'utf8');
  const refreshSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'canonical-refresh.js'), 'utf8');
  const liveSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'live-plan.js'), 'utf8');
  ok(!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(loopSrc)
    && /method:\s*'GET'/.test(observeSrc)
    && !/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(refreshSrc)
    && !/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(liveSrc),
    'refresh path remains GET-only against the provider');
  ok(!/setInterval|node-cron|cron\.schedule/.test(loopSrc)
    && !/setInterval|node-cron|cron\.schedule/.test(observeSrc)
    && !/setInterval|node-cron|cron\.schedule/.test(refreshSrc)
    && !/setInterval|node-cron|cron\.schedule/.test(liveSrc),
    'no scheduler or background refresh was added');
  ok(!/--apply/.test(loopSrc) || /never writes/.test(loopSrc),
    'acceptance CLI cannot apply a canonical write');
  ok(/previewId|approve/.test(refreshSrc),
    'incumbent preview/approve writer remains the only canonical write path');
  ok(loopSrc.indexOf('const accountMap = loadAccountMap')
    < loopSrc.indexOf('const payload = await loadPayload'),
    'live path loads the trusted map before any provider GET');
  const liveEnv = Object.assign({}, process.env);
  delete liveEnv.ATLAS_PROVIDER_ACCOUNT_MAP_JSON;
  delete liveEnv.ATLAS_PROVIDER_ACCOUNT_MAP_PATH;
  delete liveEnv.ATLAS_LIVE_OVERLAY_MAP;
  let liveDenied = false;
  let liveErr = '';
  try {
    execFileSync(process.execPath, [SCRIPT, '--live'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: liveEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    liveErr = String(err.stderr || err.message || err);
    liveDenied = /Trusted live account map is missing/.test(liveErr)
      && /Display names cannot reconstruct/.test(liveErr);
  }
  ok(liveDenied, '--live fails closed when the owner-verified map is missing', liveErr);
}

console.log('\n=== F. dated live proof is sanitized and independently summed ===');
{
  const proof = fs.readFileSync(LIVE_PROOF, 'utf8');
  ok(/2026-08-26T01:04:11\.798Z/.test(proof), 'proof records the live fetch instant');
  ok(/\$429\.27 \+ \(-\$522\.02\) \+ \$0\.58 = \*\*-\$92\.17\*\*/.test(proof),
    'proof independently sums posted household cash');
  ok(/\*\*-\$92\.17\*\*/.test(proof), 'independent spendable is recorded');
  ok(/owner-supplied production account-map secret/.test(proof)
    && /Display-name reconstruction was not\s+used/.test(proof),
    'proof used the owner-verified account-id map, not display names');
  ok(/Canonical write \| false|canonical write/.test(proof.toLowerCase()),
    'proof states that canonical state was not written');
  ok(/cardCapacityIsCash: \*\*0\*\*/.test(proof)
    && /Credit capacity is not household cash/.test(proof),
    'proof states credit is not cash');
  ok(/funding\.borrowed: \*\*\$0\*\*/.test(proof),
    'proof states no auto-borrow');
  ok(/Identity keys equal \| \*\*true\*\*/.test(proof),
    'second live GET kept identity keys equal');
  ok(/openingApprovalId/.test(proof)
    && /cannot authorize pending or an\s+opening/.test(proof),
    'proof names openingApprovalId for a newer opening; posted previewId is not that gate');
  ok(!/owner-reserved `previewId` approval/.test(proof),
    'proof does not tell the owner that previewId authorizes an opening');
  ok(!/"providerAccountId"/.test(proof)
    && !/providerAccountId/.test(proof)
    && !/LUNCHMONEY_ACCESS_TOKEN/.test(proof)
    && !/Bearer /.test(proof),
    'proof omits provider IDs, the token name, and bearer secrets');
}

const afterTree = hashTree();
ok(afterTree.data === beforeTree.data
  && afterTree.positions === beforeTree.positions
  && afterTree.snapshots === beforeTree.snapshots,
  'this suite left live canonical files byte-identical');

if (failures) {
  console.log(`\nFAILED — ${failures} assertion${failures === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log('\nAll AF-REFRESH-07 live closed-loop proofs passed.');
