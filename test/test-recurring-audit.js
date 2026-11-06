'use strict';
/* Read-only recurring card-charge audit.
 *
 * Synthetic fixtures only. None of these rows is a household transaction.
 * `node test/test-recurring-audit.js`
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Forecast = require('../public/forecast.js');
const Audit = require('../scripts/recurring-audit.js');

const ROOT = path.join(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'data.json');
const householdData = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

let failures = 0;
function ok(cond, label, detail = '') {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function charge(overrides) {
  const row = {
    date: '2026-01-15',
    amount: 40,
    cardId: 'travelvisa',
    cardLabel: 'Travel Visa',
    merchantLabel: 'ACME WIDGETS',
    merchantKey: 'ACMEWIDGETS',
    amazonMerchant: false,
    amazonPrimeLike: false,
    ...overrides,
  };
  if (overrides.merchantLabel && overrides.merchantKey == null) {
    row.merchantKey = Audit.merchantFamilyKey(overrides.merchantLabel);
    row.amazonMerchant = Audit.isAmazonMerchantLabel(overrides.merchantLabel);
    row.amazonPrimeLike = Audit.isAmazonPrimeLikeLabel(overrides.merchantLabel);
  }
  return row;
}

// Explicit invented native evidence for the identity-backed audit controls.
function qualifiedCharge(overrides) {
  return charge({ currency: 'cad', pending: false, savingsPostingEvidence: 'posted',
    asOf: '2026-09-03', ...overrides });
}

function miniPlan(extraBills) {
  return {
    bills: extraBills || [
      { id: 'netflix', label: 'Netflix', frequency: 'monthly', amount: 26.87 },
      { id: 'spotify', label: 'Spotify', frequency: 'monthly', amount: 26.87 },
    ],
  };
}

function miniData(plan) {
  return {
    plan: plan || miniPlan(),
    debts: [
      { id: 'travelvisa', label: 'Travel Visa' },
      { id: 'mbna', label: 'Amazon.ca Rewards Mastercard (MBNA)' },
      { id: 'cashback', label: 'TD Cash Back Visa' },
      { id: 'triangle', label: 'Triangle Mastercard' },
      { id: 'tdcc', label: 'TD credit card' },
      { id: 'heloc', label: 'HELOC' },
      { id: 'mortgage', label: 'Mortgage' },
    ],
  };
}

function findCandidate(report, merchantKey, cardId) {
  return (report.candidates || []).find(row =>
    row.merchantKey === merchantKey && (!cardId || row.cardId === cardId));
}

const syntheticMap = {
  schema: 'atlas-provider-account-map/v1',
  provider: 'lunchmoney',
  scope: 'fixture',
  mappings: [
    {
      providerAccountId: 'syn-tv',
      atlasRole: 'revolving-credit',
      canonical: { collection: 'debts', id: 'travelvisa' },
    },
    {
      providerAccountId: 'syn-mbna',
      atlasRole: 'revolving-credit',
      canonical: { collection: 'debts', id: 'mbna' },
    },
    {
      providerAccountId: 'syn-cash',
      atlasRole: 'household-cash',
      canonical: { collection: 'cash', id: 'chequing-a' },
    },
    { providerAccountId: 'syn-ext', atlasRole: 'household-external' },
  ],
};

function lmTx(id, account, date, amount, payee, extra) {
  return {
    id,
    account_id: account,
    date,
    amount,
    payee,
    is_pending: false,
    status: 'cleared',
    ...(extra || {}),
  };
}

console.log('=== 1. three monthly near-equal charges are monthly recurring ===');
{
  const charges = [
    charge({ date: '2026-01-15', amount: 40.00, merchantLabel: 'PHOENIX GYM' }),
    charge({ date: '2026-02-14', amount: 40.10, merchantLabel: 'PHOENIX GYM' }),
    charge({ date: '2026-03-16', amount: 39.90, merchantLabel: 'PHOENIX GYM' }),
  ];
  const cadence = Audit.classifyCadence(charges.map(c => c.date));
  ok(cadence.cadence === 'monthly', 'cadence is monthly', cadence.cadence);
  const report = Audit.auditFromCharges(charges, { plan: miniPlan(), source: 'fixture' });
  const row = findCandidate(report, 'PHOENIXGYM', 'travelvisa');
  ok(row && row.cadence === 'monthly' && row.atlasStatus === 'candidate-unplanned',
    'three near-equal monthly charges are an unplanned candidate',
    row && `${row.cadence} ${row.atlasStatus}`);
  ok(row && (row.amountPattern === 'near-fixed' || row.amountPattern === 'fixed'),
    'near-equal amounts classify as fixed/near-fixed', row && row.amountPattern);
}

console.log('\n=== 2. month-length drift does not break monthly detection ===');
{
  const dates = ['2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30'];
  const cadence = Audit.classifyCadence(dates);
  ok(cadence.cadence === 'monthly', '28–31 day drift is still monthly', cadence.cadence);
  const charges = dates.map((date, i) => charge({
    date,
    amount: 179.00,
    merchantLabel: 'PHOENIX GYM',
  }));
  const report = Audit.auditFromCharges(charges, { plan: miniPlan(), source: 'fixture' });
  const row = findCandidate(report, 'PHOENIXGYM');
  ok(row && row.cadence === 'monthly' && row.occurrenceCount === 4,
    'drifted month-end dates stay one monthly candidate');
}

console.log('\n=== 3. true 14-day cadence is not monthly ===');
{
  const dates = ['2026-01-02', '2026-01-16', '2026-01-30', '2026-02-13'];
  const cadence = Audit.classifyCadence(dates);
  ok(cadence.cadence === 'biweekly', 'true 14-day walk is biweekly', cadence.cadence);
  ok(cadence.cadence !== 'monthly' && cadence.cadence !== 'semi-monthly',
    '14-day walk is not monthly and not semi-monthly');
  const semi = Audit.classifyCadence([
    '2026-01-01', '2026-01-15', '2026-02-01', '2026-02-15', '2026-03-01', '2026-03-15',
  ]);
  ok(semi.cadence === 'semi-monthly',
    '1st/15th clusters are semi-monthly, not biweekly', semi.cadence);
}

console.log('\n=== 4. quarterly recurrence is detected ===');
{
  const dates = ['2025-09-18', '2025-12-18', '2026-03-18'];
  const cadence = Audit.classifyCadence(dates);
  ok(cadence.cadence === 'quarterly', 'three ~90-day charges are quarterly', cadence.cadence);
  const report = Audit.auditFromCharges(dates.map(date => charge({
    date,
    amount: 95.85,
    merchantLabel: 'NOBLE DISPOSAL',
  })), { plan: miniPlan(), source: 'fixture' });
  const row = findCandidate(report, 'NOBLEDISPOSAL');
  ok(row && row.cadence === 'quarterly' && row.atlasStatus === 'candidate-unplanned',
    'quarterly merchant without a matching bill is unplanned');
}

console.log('\n=== 5. annual recurrence is detected when history exists ===');
{
  const dates = ['2024-05-08', '2025-05-08'];
  const cadence = Audit.classifyCadence(dates);
  ok(cadence.cadence === 'annual', 'two charges ~365 days apart are annual', cadence.cadence);
  const three = Audit.classifyCadence(['2023-05-08', '2024-05-08', '2025-05-08']);
  ok(three.cadence === 'annual', 'three annual charges stay annual', three.cadence);
}

console.log('\n=== 6. fixed recurring amounts are distinct from variable ===');
{
  const dates = ['2026-01-10', '2026-02-09', '2026-03-11'];
  const fixed = Audit.classifyAmountPattern([14.99, 14.99, 14.99], 'monthly');
  const near = Audit.classifyAmountPattern([40.00, 40.10, 39.90], 'monthly');
  const variable = Audit.classifyAmountPattern([42.00, 67.50, 19.99], 'monthly');
  ok(fixed.amountPattern === 'fixed', 'identical amounts are fixed', fixed.amountPattern);
  ok(near.amountPattern === 'near-fixed', 'cent-level drift is near-fixed', near.amountPattern);
  ok(variable.amountPattern === 'variable', 'wide amount spread is variable', variable.amountPattern);
  ok(Audit.classifyCadence(dates).cadence === 'monthly',
    'the variable series still has monthly cadence');
}

console.log('\n=== 7. two isolated same-merchant transactions are not a bill ===');
{
  const charges = [
    charge({ date: '2026-01-04', amount: 88.00, merchantLabel: 'RARE SHOP' }),
    charge({ date: '2026-02-03', amount: 88.00, merchantLabel: 'RARE SHOP' }),
  ];
  const cadence = Audit.classifyCadence(charges.map(c => c.date));
  ok(cadence.cadence === 'irregular', 'two ~30-day hits are not a cadence class', cadence.cadence);
  const report = Audit.auditFromCharges(charges, { plan: miniPlan(), source: 'fixture' });
  const row = findCandidate(report, 'RARESHOP');
  ok(row && row.atlasStatus === 'repeating-not-bill',
    'two isolated charges are repeating-not-bill', row && row.atlasStatus);
  ok(row && row.reviewWarranted !== true,
    'two isolated charges are not a review-warranted bill candidate');
}

console.log('\n=== 8. frequent irregular Amazon shopping is not monthly ===');
{
  const rows = [
    ['2026-06-01', 32.11],
    ['2026-06-03', 8.49],
    ['2026-06-08', 54.02],
    ['2026-06-20', 19.00],
    ['2026-07-02', 41.77],
    ['2026-07-04', 6.25],
    ['2026-07-19', 27.80],
    ['2026-07-28', 63.40],
  ].map(([date, amount]) => charge({
    date,
    amount,
    merchantLabel: 'AMAZON CA',
    cardId: 'travelvisa',
  }));
  const cadence = Audit.classifyCadence(rows.map(c => c.date));
  ok(cadence.cadence !== 'monthly', 'irregular Amazon shopping is not monthly', cadence.cadence);
  const report = Audit.auditFromCharges(rows, { plan: miniPlan(), source: 'fixture' });
  const amazon = report.amazon.byCard.find(r => r.cardId === 'travelvisa');
  ok(amazon && amazon.looksLikeShopping === true, 'Travel Visa Amazon looks like shopping');
  ok(amazon && amazon.standingRule && amazon.standingRule.id === 'amanda-amazon-travelvisa',
    'Travel Visa Amazon keeps the Amanda guilt-free standing rule');
  const candidate = findCandidate(report, 'AMAZON', 'travelvisa');
  ok(candidate && candidate.atlasStatus === 'repeating-not-bill',
    'Amazon shopping is not labelled an unplanned bill');
}

console.log('\n=== 9. MBNA Prime-like sequence is not the Travel Visa membership ===');
{
  const beforeBills = JSON.stringify(householdData.plan.bills);
  const charges = [
    charge({ date: '2026-01-10', amount: 14.99, merchantLabel: 'AMAZON PRIME', cardId: 'mbna' }),
    charge({ date: '2026-02-09', amount: 14.99, merchantLabel: 'AMAZON PRIME', cardId: 'mbna' }),
    charge({ date: '2026-03-11', amount: 14.99, merchantLabel: 'AMAZON PRIME', cardId: 'mbna' }),
  ];
  const report = Audit.auditFromCharges(charges, { plan: householdData.plan, source: 'fixture' });
  const row = findCandidate(report, 'AMAZONPRIME', 'mbna');
  ok(row && row.amazonPrimeLike && row.cadence === 'monthly',
    'Prime-like monthly sequence is detected', row && `${row.cadence} ${row.amazonPrimeLike}`);
  ok(row && row.atlasStatus === 'merchant-overlaps-planned-bill'
      && (row.overlappingBills || []).some(b => b.id === 'amazon-prime')
      && !(row.matchedBills || []).some(b => b.id === 'amazon-prime'),
    'MBNA $14.99 overlaps the membership text and is not known-planned',
    row && `${row.atlasStatus} overlap=${(row.overlappingBills || []).map(b => b.id).join(',')}`);
  const primeRows = (householdData.plan.bills || []).filter(b => b && b.id === 'amazon-prime');
  ok(primeRows.length === 1 && primeRows[0].payingAccount === 'travelvisa'
      && primeRows[0].amount === 11.19,
    'the live membership stays the one Travel Visa $11.19 row');
  ok(JSON.stringify(householdData.plan.bills) === beforeBills,
    'audit did not mutate plan.bills');
  const text = Audit.formatReport(report);
  ok(/not promoted/i.test(text), 'report says the audit did not promote a bill');
}

function identityWithCardNetflix() {
  const identity = JSON.parse(JSON.stringify(require('../docs/connectivity/transaction-identity.json')));
  identity.rules.push({
    eventId: 'netflix',
    payeePattern: 'NETFLIX',
    payeePatterns: ['NETFLIX'],
    atlasAccountId: 'cashback',
    direction: 'debit',
    note: 'Synthetic identity for audit proof only. Not a household posting rule.',
  });
  return identity;
}

console.log('\n=== 10. merchant overlap alone is not known-planned ===');
{
  const charges = [
    charge({ date: '2026-01-17', amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'cashback' }),
    charge({ date: '2026-02-17', amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'cashback' }),
    charge({ date: '2026-03-17', amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'cashback' }),
  ];
  const report = Audit.auditFromCharges(charges, { plan: householdData.plan, source: 'fixture' });
  const row = findCandidate(report, 'NETFLIXCOM', 'cashback') || findCandidate(report, 'NETFLIX', 'cashback');
  ok(row && row.atlasStatus === 'merchant-overlaps-planned-bill',
    'Netflix card charges without identity proof fail closed', row && row.atlasStatus);
  ok(row && !(row.matchedBills || []).some(b => b.id === 'netflix'),
    'merchant overlap does not claim the Netflix bill as known');
  ok(row && (row.overlappingBills || []).some(b => b.id === 'netflix'),
    'overlap is reported without promoting the row to known-planned');
  ok(!report.sections.known.some(r => /netflix/i.test(r.merchantLabel)),
    'unproven Netflix card charges are not in the known section');
}

console.log('\n=== 11. different cards for the same merchant are distinguishable ===');
{
  const charges = [
    charge({ date: '2026-01-05', amount: 179, merchantLabel: 'PHOENIX GYM', cardId: 'travelvisa' }),
    charge({ date: '2026-02-04', amount: 179, merchantLabel: 'PHOENIX GYM', cardId: 'travelvisa' }),
    charge({ date: '2026-03-06', amount: 179, merchantLabel: 'PHOENIX GYM', cardId: 'travelvisa' }),
    charge({ date: '2026-01-20', amount: 179, merchantLabel: 'PHOENIX GYM', cardId: 'mbna', cardLabel: 'Amazon Mastercard' }),
    charge({ date: '2026-02-19', amount: 179, merchantLabel: 'PHOENIX GYM', cardId: 'mbna', cardLabel: 'Amazon Mastercard' }),
    charge({ date: '2026-03-21', amount: 179, merchantLabel: 'PHOENIX GYM', cardId: 'mbna', cardLabel: 'Amazon Mastercard' }),
  ];
  const report = Audit.auditFromCharges(charges, { plan: miniPlan(), source: 'fixture' });
  const tv = findCandidate(report, 'PHOENIXGYM', 'travelvisa');
  const mbna = findCandidate(report, 'PHOENIXGYM', 'mbna');
  ok(tv && mbna && tv.cardId !== mbna.cardId, 'same merchant on two cards is two rows');
  ok(tv.occurrenceCount === 3 && mbna.occurrenceCount === 3,
    'each card keeps its own three occurrences');
}

console.log('\n=== 12. merchant normalization does not merge unrelated merchants ===');
{
  const charges = [
    charge({ date: '2026-01-02', amount: 20, merchantLabel: 'PHOENIX GYM' }),
    charge({ date: '2026-02-01', amount: 20, merchantLabel: 'PHOENIX GYM' }),
    charge({ date: '2026-03-03', amount: 20, merchantLabel: 'PHOENIX GYM' }),
    charge({ date: '2026-01-08', amount: 50, merchantLabel: 'PHOENIX INSURANCE' }),
    charge({ date: '2026-02-07', amount: 50, merchantLabel: 'PHOENIX INSURANCE' }),
    charge({ date: '2026-03-09', amount: 50, merchantLabel: 'PHOENIX INSURANCE' }),
  ];
  ok(Audit.merchantFamilyKey('PHOENIX GYM') !== Audit.merchantFamilyKey('PHOENIX INSURANCE'),
    'PHOENIX GYM and PHOENIX INSURANCE stay distinct keys');
  const report = Audit.auditFromCharges(charges, { plan: miniPlan(), source: 'fixture' });
  ok(findCandidate(report, 'PHOENIXGYM') && findCandidate(report, 'PHOENIXINSURANCE'),
    'unrelated Phoenix merchants are two candidates');
}

console.log('\n=== 13. no raw provider IDs leak into output ===');
{
  const payload = {
    provider: 'lunchmoney',
    fetchedAt: '2026-09-03T18:00:00.000Z',
    transactionWindow: { startDate: '2026-01-01', endDate: '2026-09-03', complete: true },
    accounts: [{ id: 'syn-tv', name: 'Travel Visa' }],
    transactions: [
      lmTx('prov-tx-88001', 'syn-tv', '2026-01-15', 40, 'ACME WIDGETS'),
      lmTx('prov-tx-88002', 'syn-tv', '2026-02-14', 40, 'ACME WIDGETS'),
      lmTx('prov-tx-88003', 'syn-tv', '2026-03-16', 40, 'ACME WIDGETS'),
      lmTx('prov-tx-88004', 'syn-tv', '2026-03-16', 12, 'AMAZON.CA'),
      lmTx('secret-note', 'syn-tv', '2026-03-17', 9, 'NOTESHOP', { notes: 'private note', tags: ['amanda'] }),
    ],
  };
  const report = Audit.auditObservation({
    payload,
    fetchedAt: payload.fetchedAt,
    accountMap: syntheticMap,
    data: miniData(),
    source: 'fixture',
  });
  const blob = JSON.stringify(report) + Audit.formatReport(report);
  ok(!/prov-tx-|88001|syn-tv|providerTransactionId|private note/.test(blob),
    'provider ids, map ids, and notes are absent from output');
  ok(!/"payee"\s*:/.test(JSON.stringify(report)), 'raw payee field is not in the report object');
  ok(report.writesCanonicalState === false, 'report declares no canonical write');
}

console.log('\n=== 14. no canonical write occurs ===');
{
  const before = hashFile(DATA_PATH);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-recurring-audit-'));
  const fixturePath = path.join(tmp, 'payload.json');
  const mapPath = path.join(tmp, 'map.json');
  const dataCopy = path.join(tmp, 'data.json');
  fs.writeFileSync(fixturePath, JSON.stringify({
    provider: 'lunchmoney',
    fetchedAt: '2026-09-03T18:00:00.000Z',
    transactionWindow: { startDate: '2026-01-01', endDate: '2026-09-03', complete: true },
    transactions: [
      lmTx(1, 'syn-tv', '2026-01-15', 40, 'ACME WIDGETS'),
      lmTx(2, 'syn-tv', '2026-02-14', 40, 'ACME WIDGETS'),
      lmTx(3, 'syn-tv', '2026-03-16', 40, 'ACME WIDGETS'),
    ],
  }));
  fs.writeFileSync(mapPath, JSON.stringify(syntheticMap));
  fs.copyFileSync(DATA_PATH, dataCopy);
  Audit.auditFromCharges([
    charge({ date: '2026-01-15', merchantLabel: 'ACME WIDGETS' }),
    charge({ date: '2026-02-14', merchantLabel: 'ACME WIDGETS' }),
    charge({ date: '2026-03-16', merchantLabel: 'ACME WIDGETS' }),
  ], { plan: householdData.plan, source: 'fixture' });
  const spawned = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/recurring-audit.js'),
    '--fixture', fixturePath,
    '--map', mapPath,
    '--data', dataCopy,
    '--json',
  ], { encoding: 'utf8' });
  ok(spawned.status === 0, 'CLI fixture run exits 0', spawned.stderr);
  ok(hashFile(DATA_PATH) === before, 'repository data.json hash unchanged');
  ok(hashFile(dataCopy) === before, 'copied data.json hash unchanged after CLI');
  let threw = false;
  try {
    Audit.resolveOutPath(path.join(tmp, 'report.txt'));
  } catch (err) {
    threw = /derived/.test(err.message);
  }
  ok(threw, '--out outside derived/ is refused');
}

console.log('\n=== 15. audit output is deterministic for the same evidence ===');
{
  const charges = [
    charge({ date: '2026-03-16', amount: 39.90, merchantLabel: 'PHOENIX GYM' }),
    charge({ date: '2026-01-15', amount: 40.00, merchantLabel: 'PHOENIX GYM' }),
    charge({ date: '2026-02-14', amount: 40.10, merchantLabel: 'PHOENIX GYM' }),
    charge({ date: '2026-07-04', amount: 6.25, merchantLabel: 'AMAZON CA' }),
    charge({ date: '2026-06-01', amount: 32.11, merchantLabel: 'AMAZON CA' }),
  ];
  const a = Audit.auditFromCharges(charges, { plan: miniPlan(), asOf: '2026-09-03', source: 'fixture' });
  const b = Audit.auditFromCharges(charges.slice().reverse(), {
    plan: miniPlan(), asOf: '2026-09-03', source: 'fixture',
  });
  ok(JSON.stringify(a) === JSON.stringify(b), 'same evidence yields identical JSON');
}

console.log('\n=== Amazon standing rule is not generalized ===');
{
  const flags = Forecast.classifyCurrentPeriodTransaction.derivedFlags;
  ok(Audit.isAmazonMerchantLabel('AMAZON.CA') === true, 'AMAZON.CA is Amazon');
  ok(Audit.isAmazonMerchantLabel('AMZN MKTP') === true, 'AMZN MKTP is Amazon');
  ok(Audit.isAmazonMerchantLabel('AMAZON PRIME') === true, 'AMAZON PRIME is Amazon');
  ok(Audit.isAmazonMerchantLabel('AMAZON.CA REWARDS MASTERCARD') === false,
    'Amazon Mastercard payee is not Amazon shopping');
  ok(flags({ originalMerchant: 'AMAZON.CA' }).amazonMerchant === true
    && flags({ originalMerchant: 'AMZN MKTP' }).amazonMerchant === true
    && flags({ originalMerchant: 'AMAZON.CA REWARDS MASTERCARD' }).amazonMerchant === false,
    'audit Amazon identity agrees with Forecast.derivedFlags');
  const mbnaAmazon = Audit.standingRuleFor(charge({
    merchantLabel: 'AMAZON CA', cardId: 'mbna',
  }));
  const tvAmazon = Audit.standingRuleFor(charge({
    merchantLabel: 'AMAZON CA', cardId: 'travelvisa',
  }));
  ok(!mbnaAmazon, 'Amazon on MBNA is not Amanda guilt-free by this rule');
  ok(tvAmazon && tvAmazon.id === 'amanda-amazon-travelvisa',
    'Amazon on Travel Visa is the standing Amanda rule');
}

console.log('\n=== Phoenix investigation reports single vs monthly evidence ===');
{
  const one = Audit.auditFromCharges([
    charge({ date: '2026-08-20', amount: 179.12, merchantLabel: 'PHOENIX GYM' }),
  ], { plan: miniPlan(), source: 'fixture' });
  ok(one.phoenix.found && one.phoenix.occurrenceCount === 1, 'single Phoenix hit is found');
  ok(/SINGLE OCCURRENCE/i.test(one.phoenix.evidenceStatus),
    'one hit is not called recurring');
  ok(one.phoenix.supportsMonthly === false, 'one hit does not support monthly');
  ok(one.phoenix.around179Count === 1, '~$179 window counts the 179.12 charge');
  const monthly = Audit.auditFromCharges([
    charge({ date: '2026-06-20', amount: 179.00, merchantLabel: 'PHOENIX GYM' }),
    charge({ date: '2026-07-20', amount: 179.00, merchantLabel: 'PHOENIX GYM' }),
    charge({ date: '2026-08-20', amount: 179.12, merchantLabel: 'PHOENIX GYM' }),
  ], { plan: miniPlan(), source: 'fixture' });
  ok(monthly.phoenix.supportsMonthly === true
    && monthly.phoenix.alreadyPlanned === false,
    'three ~$179 monthly hits support monthly and are not planned');
}

console.log('\n=== Observation adapter keeps only mapped revolving cards ===');
{
  const payload = {
    provider: 'lunchmoney',
    fetchedAt: '2026-09-03T18:00:00.000Z',
    transactionWindow: { startDate: '2026-01-01', endDate: '2026-09-03', complete: true },
    transactions: [
      lmTx(11, 'syn-tv', '2026-01-15', 40, 'ACME WIDGETS'),
      lmTx(12, 'syn-tv', '2026-02-14', 40, 'ACME WIDGETS'),
      lmTx(13, 'syn-tv', '2026-03-16', 40, 'ACME WIDGETS'),
      lmTx(14, 'syn-cash', '2026-03-16', 26.87, 'NETFLIX'),
      lmTx(15, 'syn-ext', '2026-03-16', 99, 'EXTERNAL SHOP'),
      lmTx(16, 'syn-unknown', '2026-03-16', 50, 'UNMAPPED CARD'),
      lmTx(17, 'syn-tv', '2026-03-16', 10, 'PAYMENT THANK YOU'),
      lmTx(18, 'syn-heloc', '2026-03-16', 5, 'INTEREST', { category_name: 'Interest Charge' }),
    ],
  };
  const extracted = Audit.chargesFromNormalized({
    payload,
    fetchedAt: payload.fetchedAt,
    accountMap: syntheticMap,
    data: miniData(),
  });
  ok(extracted.charges.every(c => c.cardId === 'travelvisa'),
    'only the mapped Travel Visa revolving account is audited');
  ok(!extracted.charges.some(c => /NETFLIX|EXTERNAL|UNMAPPED|PAYMENT/i.test(c.merchantLabel)),
    'chequing, external, unmapped, and payment rows are excluded');
  ok(extracted.charges.length === 3, 'three ACME card charges remain', String(extracted.charges.length));
}

console.log('\n=== Thresholds are conservative and documented ===');
{
  ok(Audit.THRESHOLDS.monthly.minOccurrences === 3, 'monthly requires three occurrences');
  ok(Audit.THRESHOLDS.monthly.intervalMin === 26 && Audit.THRESHOLDS.monthly.intervalMax === 35,
    'monthly interval window allows month-length drift');
  ok(Audit.THRESHOLDS.isolatedPairMax === 2, 'two hits are the isolated-pair ceiling');
  ok(Audit.SCHEMA === 'atlas-recurring-card-audit/v1', 'schema id is stable');
}

console.log('\n=== 16. GOOGLE PLAY on a card is not google-storage-100gb ===');
{
  const charges = [
    qualifiedCharge({ date: '2026-01-31', amount: 3.13, merchantLabel: 'GOOGLE PLAY', cardId: 'travelvisa' }),
    qualifiedCharge({ date: '2026-02-28', amount: 3.13, merchantLabel: 'GOOGLE PLAY', cardId: 'travelvisa' }),
    qualifiedCharge({ date: '2026-03-31', amount: 3.13, merchantLabel: 'GOOGLE PLAY', cardId: 'travelvisa' }),
  ];
  const report = Audit.auditFromCharges(charges, { plan: householdData.plan, source: 'fixture' });
  const row = findCandidate(report, 'GOOGLEPLAY', 'travelvisa');
  ok(row, 'GOOGLE PLAY recurring card charges are reported');
  ok(row && row.atlasStatus !== 'known-planned',
    'GOOGLE PLAY is not known-planned', row && row.atlasStatus);
  ok(row && !(row.matchedBills || []).some(b => b.id === 'google-storage-100gb'),
    'GOOGLE PLAY is not matched as google-storage-100gb');
  ok(row && (row.overlappingBills || []).some(b => b.id === 'google-storage-100gb'),
    'GOOGLE PLAY is surfaced as overlapping the storage bill, not hidden as known');
  const googleIdentity = Audit.matchKnownBills(charges[2], householdData.plan);
  ok(!(googleIdentity || []).some(b => b.id === 'google-storage-100gb'),
    'incumbent identity refuses GOOGLE PLAY as google-storage-100gb');
}

console.log('\n=== 17. unexpected card/account is not the planned bill by merchant text ===');
{
  const identity = identityWithCardNetflix();
  const charges = [
    qualifiedCharge({ date: '2026-01-17', amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'travelvisa' }),
    qualifiedCharge({ date: '2026-02-17', amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'travelvisa' }),
    qualifiedCharge({ date: '2026-03-17', amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'travelvisa' }),
  ];
  const report = Audit.auditFromCharges(charges, {
    plan: householdData.plan, identity, source: 'fixture',
  });
  const row = findCandidate(report, 'NETFLIXCOM', 'travelvisa') || findCandidate(report, 'NETFLIX', 'travelvisa');
  ok(row && row.atlasStatus !== 'known-planned',
    'Netflix on Travel Visa is not the cashback-identity Netflix bill', row && row.atlasStatus);
  ok(row && !(row.matchedBills || []).some(b => b.id === 'netflix'),
    'wrong-card Netflix is not matched as known');
  ok(row && row.atlasStatus === 'merchant-overlaps-planned-bill',
    'wrong-card Netflix fails closed to merchant-overlaps-planned-bill');
}

console.log('\n=== 18. authority-backed identity can still report known ===');
{
  const identity = identityWithCardNetflix();
  const charges = [
    qualifiedCharge({ date: '2026-01-17', amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'cashback' }),
    qualifiedCharge({ date: '2026-02-17', amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'cashback' }),
    qualifiedCharge({ date: '2026-03-17', amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'cashback' }),
  ];
  const report = Audit.auditFromCharges(charges, {
    plan: householdData.plan, identity, source: 'fixture',
  });
  const row = findCandidate(report, 'NETFLIXCOM', 'cashback') || findCandidate(report, 'NETFLIX', 'cashback');
  ok(row && row.atlasStatus === 'known-planned',
    'cashback + NETFLIX + scheduled/posting date proves the incumbent Netflix bill',
    row && row.atlasStatus);
  ok(row && row.matchedBills.some(b => b.id === 'netflix'),
    'matched bill id is netflix');
  ok(report.sections.known.some(r => r.matchedBills.some(b => b.id === 'netflix')),
    'known section lists the identity-backed Netflix row');
  ok(!report.sections.strong.some(r => /netflix/i.test(r.merchantLabel)),
    'identity-backed Netflix is not an undiscovered strong candidate');
}

console.log('\n=== 19. identity-backed known path still writes nothing ===');
{
  const before = hashFile(DATA_PATH);
  const identity = identityWithCardNetflix();
  const report = Audit.auditFromCharges([
    qualifiedCharge({ date: '2026-01-17', amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'cashback' }),
    qualifiedCharge({ date: '2026-02-17', amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'cashback' }),
    qualifiedCharge({ date: '2026-03-17', amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'cashback' }),
    qualifiedCharge({ date: '2026-01-31', amount: 3.13, merchantLabel: 'GOOGLE PLAY', cardId: 'travelvisa' }),
    qualifiedCharge({ date: '2026-02-28', amount: 3.13, merchantLabel: 'GOOGLE PLAY', cardId: 'travelvisa' }),
    qualifiedCharge({ date: '2026-03-31', amount: 3.13, merchantLabel: 'GOOGLE PLAY', cardId: 'travelvisa' }),
  ], { plan: householdData.plan, identity, source: 'fixture' });
  ok(report.writesCanonicalState === false, 'identity-backed report still declares no canonical write');
  ok(hashFile(DATA_PATH) === before, 'data.json hash unchanged after identity-backed audit');
  ok(!/LUNCHMONEY|POST |PUT |PATCH |DELETE /i.test(JSON.stringify(report)),
    'report does not describe a Lunch Money write');
}

console.log('\n=== 20. same merchant + correct card + wrong bill date is not known-planned ===');
{
  const identity = identityWithCardNetflix();
  const charges = [
    qualifiedCharge({ date: '2026-01-05', amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'cashback' }),
    qualifiedCharge({ date: '2026-02-05', amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'cashback' }),
    qualifiedCharge({ date: '2026-03-05', amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'cashback' }),
  ];
  const report = Audit.auditFromCharges(charges, {
    plan: householdData.plan, identity, source: 'fixture',
  });
  const row = findCandidate(report, 'NETFLIXCOM', 'cashback') || findCandidate(report, 'NETFLIX', 'cashback');
  ok(row && row.atlasStatus !== 'known-planned',
    'Netflix on cashback dated the 5th is not the day-17 Netflix bill', row && row.atlasStatus);
  ok(row && !(row.matchedBills || []).some(b => b.id === 'netflix'),
    'wrong-date Netflix is not matched as known');
  ok(row && row.atlasStatus === 'merchant-overlaps-planned-bill',
    'wrong-date Netflix fails closed to merchant-overlaps-planned-bill');
  ok(row && (row.overlappingBills || []).some(b => b.id === 'netflix'),
    'wrong-date Netflix is surfaced as overlapping, not hidden as known');
  ok(!report.sections.known.some(r => /netflix/i.test(r.merchantLabel)),
    'wrong-date Netflix is not in the known section');
}

console.log('\n=== 21. same merchant + correct card + allowed date may be known-planned ===');
{
  const identity = identityWithCardNetflix();
  const charges = [
    qualifiedCharge({ date: '2026-01-17', amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'cashback' }),
    qualifiedCharge({ date: '2026-02-17', amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'cashback' }),
    qualifiedCharge({ date: '2026-03-17', amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'cashback' }),
  ];
  const report = Audit.auditFromCharges(charges, {
    plan: householdData.plan, identity, source: 'fixture',
  });
  const row = findCandidate(report, 'NETFLIXCOM', 'cashback') || findCandidate(report, 'NETFLIX', 'cashback');
  ok(row && row.atlasStatus === 'known-planned',
    'Netflix on cashback dated the 17th is known when incumbent identity proves that occurrence',
    row && row.atlasStatus);
  ok(row && row.matchedBills.some(b => b.id === 'netflix' && b.identity === 'payee+account+date'),
    'known match uses the incumbent payee+account+date identity label');
  ok(report.writesCanonicalState === false, 'allowed-date known path still declares no canonical write');
}

console.log('\n=== 22. unqualified direct charges never become known-planned ===');
{
  const identity = identityWithCardNetflix();
  for (const missing of ['currency', 'pending', 'savingsPostingEvidence', 'asOf']) {
    const charges = ['2026-01-17', '2026-02-17', '2026-03-17'].map(date => {
      const row = qualifiedCharge({ date, amount: 26.87, merchantLabel: 'NETFLIX COM', cardId: 'cashback' });
      delete row[missing]; return row;
    });
    const report = Audit.auditFromCharges(charges, { plan: householdData.plan, identity, source: 'fixture' });
    ok(!report.sections.known.some(row => row.matchedBills.some(b => b.id === 'netflix')),
      'direct charge without ' + missing + ' stays unconfirmed');
  }
}

console.log('\n=== 23. normalized observation forwards existing native proof privately ===');
{
  const mapping = syntheticMap.mappings.find(row => row.canonical?.id === 'travelvisa');
  const data = miniData({ bills: [{ id: 'invented-audit-bill', label: 'Invented video',
    frequency: 'monthly', day: 17, firstDue: '2026-01-17', amount: 52.61 }] });
  const identity = { rules: [{ eventId: 'invented-audit-bill', payeePattern: 'INVENTED VIDEO',
    atlasAccountId: 'travelvisa', direction: 'debit' }] };
  const normalized = { transactions: ['2026-01-17', '2026-02-17', '2026-03-17'].map((date, i) => ({
    providerTransactionId: 'invented-audit-native-' + i, providerAccountId: mapping.providerAccountId,
    date, amount: 37.41, currency: 'cad', pending: false, savingsPostingEvidence: 'posted',
    payee: 'INVENTED VIDEO', originalName: 'INVENTED VIDEO' })) };
  const input = { normalized, data, identity, accountMap: syntheticMap, asOf: '2026-03-18', source: 'fixture' };
  const report = Audit.auditObservation(input);
  ok(report.sections.known.some(row => row.matchedBills.some(b => b.id === 'invented-audit-bill')),
    'qualified normalized receipt is forwarded into the existing identity authority');
  ok(!JSON.stringify(report).includes('invented-audit-native-'), 'native receipt ids stay out of the report');
  const missing = structuredClone(input); delete missing.asOf;
  ok(!Audit.auditObservation(missing).sections.known.length, 'normalized input without as-of stays unconfirmed');
}

if (failures) {
  console.log(`\n${failures} FAILING`);
  process.exit(1);
}
console.log('\nAll recurring-audit checks passed');
