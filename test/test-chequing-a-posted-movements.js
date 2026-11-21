'use strict';
/* Posted movement evidence set for canonical chequing-a.
 *
 * Forecast composes proven posted provider transactions that affected
 * chequing-a during an evidence window. That packet is not leftover,
 * not Current Balance, not Prepare Ahead, and not the BILLS walk.
 * Display names are labels only. Missing coverage fails closed.
 * Pending is not posted. Unknown purpose stays UNKNOWN.
 *
 * Independent reconstruction uses the incumbent currentPeriodActuals
 * rows (L-002). Live data.json cents are not the specification (L-006).
 *
 * `node test/test-chequing-a-posted-movements.js`
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');
const SNAPSHOT_DIR = path.join(ROOT, 'snapshots');
const liveHash = hashFile(DATA);
const snapshotHashes = fs.readdirSync(SNAPSHOT_DIR)
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => `${name}:${hashFile(path.join(SNAPSHOT_DIR, name))}`);

function filesUnchanged(label) {
  ok(hashFile(DATA) === liveHash, `${label}: data.json bytes unchanged`);
  const now = fs.readdirSync(SNAPSHOT_DIR)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => `${name}:${hashFile(path.join(SNAPSHOT_DIR, name))}`);
  ok(now.length === snapshotHashes.length
      && now.every((row, i) => row === snapshotHashes[i]),
    `${label}: snapshots unchanged`);
}

const PAYDAY = '2026-08-28';
const WINDOW = { start: PAYDAY, through: PAYDAY };
const DALE = 1800;
const GROCERY = 42.17;
const BILL = 87.65;
const REFUND = 12.4;
const UNKNOWN_DEBIT = 19.99;
const TFR_TO_B = 25;
const TFR_FROM_B = 40;
const TFR_TO_SAVINGS = 80;
const CARD_PMT = 110;
const PENDING_DEBIT = 33.33;
const BILLS_OPENING = 412.07;
const WEEKLY_OPENING = 88.41;
const SAVINGS_OPENING = 15.55;
const POOLED = roundCent(BILLS_OPENING + WEEKLY_OPENING);
const TFR_RE = /\b([A-Z]{2}\d{3})\s+TFR-(TO|FR)\b/i;
const CASH_LOCATIONS = new Set(['chequing-a', 'chequing-b', 'savings']);

function fixturePlan(extra) {
  const opts = extra || {};
  return {
    defaults: { targetBuffer: 0 },
    startingCash: {
      amount: BILLS_OPENING + WEEKLY_OPENING + SAVINGS_OPENING,
      breakdown: [
        {
          id: 'chequing-a',
          label: opts.billsLabel || 'BILLS ACCOUNT',
          value: BILLS_OPENING,
        },
        { id: 'chequing-b', label: 'WEEKLY SPENDING', value: WEEKLY_OPENING },
        { id: 'savings', label: 'EMERGENCY SAVING', value: SAVINGS_OPENING },
      ],
    },
    nextDollar: {
      policy: 'true-surplus-highest-interest',
      provenance: 'owner-stated',
    },
    opening: { asOf: PAYDAY, representedEvents: [{ id: 'payroll', date: PAYDAY }] },
    income: [
      {
        id: 'payroll', label: 'Dale income', frequency: 'biweekly',
        anchor: '2026-08-14', amount: DALE, confidence: 'confirmed',
      },
    ],
    bills: opts.bills || [],
    obligations: [],
    commitments: [],
    budget: {
      categories: [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          plannedMonthly: 450, ownerLine: 'Groceries',
        },
      ],
    },
  };
}

function packet(txs, extra) {
  const opts = extra || {};
  return {
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: PAYDAY,
    coverageStart: opts.coverageStart || PAYDAY,
    coverageThrough: opts.coverageThrough || PAYDAY,
    pendingCoverage: opts.pendingCoverage || 'complete',
    transactionCoverage: opts.transactionCoverage || 'complete',
    representedActuals: opts.representedActuals || [],
    transactions: txs,
  };
}

function tx(opts) {
  return {
    id: opts.id,
    date: Object.prototype.hasOwnProperty.call(opts, 'date') ? opts.date : PAYDAY,
    amount: opts.amount,
    pending: opts.pending === true,
    pendingTreatment: opts.pendingTreatment,
    categoryLabel: opts.categoryLabel || null,
    accountRole: opts.accountRole || 'household-cash',
    atlasAccountId: opts.atlasAccountId,
    account: opts.atlasAccountId,
    excludeFromTotals: opts.excludeFromTotals === true,
    kindHint: opts.kindHint || null,
    displayedPayee: opts.payee || null,
    originalMerchant: opts.payee || null,
    isIncome: opts.isIncome === true,
    isGroup: opts.isGroup === true,
    parentId: opts.parentId || null,
    representedBill: opts.representedBill === true,
    tfrReference: opts.tfrReference || null,
    tfrDirection: opts.tfrDirection || null,
  };
}

function tfrLeg(opts) {
  const dir = opts.dir;
  const amount = dir === 'TO' ? opts.amount : -opts.amount;
  const row = {
    id: opts.id,
    amount,
    atlasAccountId: opts.atlasAccountId,
    excludeFromTotals: true,
    kindHint: 'transfer',
    payee: opts.payee,
    tfrReference: opts.tfrReference,
    tfrDirection: dir,
    pending: opts.pending === true,
  };
  if (opts.date !== undefined) row.date = opts.date;
  return tx(row);
}

function parseIndependentTfr(row) {
  if (!row) return null;
  if (row.tfrReference && (row.tfrDirection === 'TO' || row.tfrDirection === 'FR')) {
    return {
      ref: String(row.tfrReference).toUpperCase(),
      dir: String(row.tfrDirection).toUpperCase(),
    };
  }
  const blob = [row.displayedPayee, row.originalMerchant, row.payee]
    .filter(Boolean).join(' ');
  const match = TFR_RE.exec(blob);
  if (!match) return null;
  return { ref: match[1].toUpperCase(), dir: match[2].toUpperCase() };
}

function independentCashLocation(row) {
  if (!row) return null;
  if (row.accountRole === 'household-external' || row.accountRole === 'unmapped') {
    return null;
  }
  if (row.accountRole && row.accountRole !== 'household-cash') return null;
  const id = String(row.atlasAccountId || row.accountId || row.account || '').trim();
  return CASH_LOCATIONS.has(id) ? id : null;
}

function independentPairs(txs) {
  const groups = new Map();
  for (const row of txs || []) {
    if (!row || row.pending === true || row.id == null) continue;
    const parsed = parseIndependentTfr(row);
    const loc = independentCashLocation(row);
    if (!parsed || !loc) continue;
    const amt = Number(row.amount);
    if (parsed.dir === 'TO' && !(amt > 0)) continue;
    if (parsed.dir === 'FR' && !(amt < 0)) continue;
    const list = groups.get(parsed.ref) || [];
    list.push({ tx: row, parsed, loc, amt });
    groups.set(parsed.ref, list);
  }
  const byTxId = new Map();
  groups.forEach((legs, ref) => {
    if (legs.length !== 2) return;
    const left = legs[0];
    const right = legs[1];
    if (left.parsed.dir === right.parsed.dir) return;
    if (left.loc === right.loc) return;
    if (roundCent(Math.abs(left.amt)) !== roundCent(Math.abs(right.amt))) return;
    const source = left.parsed.dir === 'TO' ? left : right;
    const dest = left.parsed.dir === 'FR' ? left : right;
    const movement = {
      amount: roundCent(Math.abs(source.amt)),
      sourceAccountId: source.loc,
      destinationAccountId: dest.loc,
      sourceTransactionId: String(source.tx.id),
      destinationTransactionId: String(dest.tx.id),
      tfrReference: ref,
    };
    byTxId.set(String(source.tx.id), { movement, role: 'source' });
    byTxId.set(String(dest.tx.id), { movement, role: 'destination' });
  });
  return byTxId;
}

function skipIndependentParent(row, txs) {
  if (!row || row.isGroup !== true) return false;
  const id = row.id != null ? String(row.id) : null;
  if (!id) return txs.some(child => child && child !== row && child.parentId);
  return txs.some(child => child && child.parentId != null
    && String(child.parentId) === id);
}

function independentClassification(row, proven, representedIds) {
  if (proven && proven.movement) return 'internal-transfer';
  if (row.isIncome === true) return 'income';
  if (Number(row.amount) < 0) return 'refund';
  if (row.representedBill === true || representedIds.has(String(row.id))) return 'bill';
  if (row.kindHint === 'card-payment' || row.kindHint === 'payment') return 'card-payment';
  const label = String(row.categoryLabel || '').trim().toLowerCase();
  if (label === 'groceries' || label === 'grocery') return 'spend';
  return 'UNKNOWN';
}

// Independent of Forecast.postedAccountMovements: posted chequing-a
// transactions in the window, Lunch Money debit negated to household-cash
// sign, unique tx id, pending excluded, split parents skipped.
function independentPostedChequingA(txs, window, extra) {
  const opts = extra || {};
  const representedIds = new Set();
  for (const row of opts.representedActuals || []) {
    if (row && row.transactionId != null) representedIds.add(String(row.transactionId));
    for (const id of row && row.transactionIds || []) representedIds.add(String(id));
  }
  const pairs = independentPairs(txs);
  const seen = new Set();
  const movements = [];
  let duplicate = false;
  let untrusted = false;
  for (const row of txs || []) {
    if (!row || !row.date) continue;
    if (String(row.date) < window.start || String(row.date) > window.through) continue;
    if (row.pending === true) continue;
    if (skipIndependentParent(row, txs)) continue;
    if (independentCashLocation(row) !== 'chequing-a') continue;
    const debit = Number(row.amount);
    if (!Number.isFinite(debit)) {
      untrusted = true;
      break;
    }
    if (debit === 0) continue;
    if (row.id == null || row.id === '') {
      untrusted = true;
      break;
    }
    const id = String(row.id);
    if (seen.has(id)) {
      duplicate = true;
      break;
    }
    seen.add(id);
    const amount = roundCent(-debit);
    const proven = pairs.get(id) || null;
    movements.push({
      id,
      accountId: 'chequing-a',
      date: String(row.date),
      amount,
      direction: amount > 0 ? 'inflow' : 'outflow',
      internalTransfer: !!(proven && proven.movement),
      counterpartAccountId: proven && proven.movement
        ? (proven.role === 'source'
          ? proven.movement.destinationAccountId
          : proven.movement.sourceAccountId)
        : null,
      classification: independentClassification(row, proven, representedIds),
      representedBill: row.representedBill === true || representedIds.has(id),
    });
  }
  movements.sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return { movements, duplicate, untrusted };
}

function movementOpts(txs, extra) {
  return { currentPeriodActuals: packet(txs, extra) };
}

function findMove(set, id) {
  return ((set && set.movements) || []).find(row => row && row.id === id) || null;
}

function recommend(plan, extra) {
  return F.recommend(plan, PAYDAY, Object.assign({
    targetBuffer: 0,
    debts: [{
      id: 'heloc', label: 'HELOC', secured: true, structure: 'Revolving',
      balance: 10000, rate: 5.45, payment: 50, pending: 0,
    }],
  }, extra || {}));
}

function operatingSnapshot(advice) {
  const view = advice && advice.defaultView || {};
  const alloc = advice && advice.paydayAllocation || {};
  const path = alloc.protectedPath || null;
  return {
    leftover: view.balanceAfterDeductions != null
      ? view.balanceAfterDeductions
      : view.predictedEndingBalance,
    currentBalance: view.liveCurrentBalance,
    afterBills: view.afterBills,
    prepareAheadWanted: path && path.wanted,
    prepareAheadAllocated: path && path.allocated,
  };
}

function snapshotsEqual(a, b) {
  return near(a.leftover, b.leftover)
    && near(a.currentBalance, b.currentBalance)
    && near(a.afterBills, b.afterBills)
    && JSON.stringify(a.prepareAheadWanted) === JSON.stringify(b.prepareAheadWanted)
    && JSON.stringify(a.prepareAheadAllocated) === JSON.stringify(b.prepareAheadAllocated);
}

const coreTxs = [
  tx({
    id: 'payroll-1', amount: -DALE, atlasAccountId: 'chequing-a',
    isIncome: true, categoryLabel: 'Income',
  }),
  tx({
    id: 'grocery-1', amount: GROCERY, atlasAccountId: 'chequing-a',
    categoryLabel: 'Groceries', payee: 'WALMART',
  }),
  tx({
    id: 'bill-1', amount: BILL, atlasAccountId: 'chequing-a',
    representedBill: true, categoryLabel: 'Bills',
  }),
  tx({
    id: 'refund-1', amount: -REFUND, atlasAccountId: 'chequing-a',
    categoryLabel: 'Shopping',
  }),
  tx({
    id: 'unknown-1', amount: UNKNOWN_DEBIT, atlasAccountId: 'chequing-a',
  }),
  tfrLeg({
    id: 'tfr-a-to-b', dir: 'TO', amount: TFR_TO_B,
    atlasAccountId: 'chequing-a', tfrReference: 'AB111',
    payee: 'AB111 TFR-TO',
  }),
  tfrLeg({
    id: 'tfr-b-from-a', dir: 'FR', amount: TFR_TO_B,
    atlasAccountId: 'chequing-b', tfrReference: 'AB111',
    payee: 'AB111 TFR-FR',
  }),
  tfrLeg({
    id: 'tfr-b-to-a', dir: 'TO', amount: TFR_FROM_B,
    atlasAccountId: 'chequing-b', tfrReference: 'AB222',
    payee: 'AB222 TFR-TO',
  }),
  tfrLeg({
    id: 'tfr-a-from-b', dir: 'FR', amount: TFR_FROM_B,
    atlasAccountId: 'chequing-a', tfrReference: 'AB222',
    payee: 'AB222 TFR-FR',
  }),
  tfrLeg({
    id: 'tfr-a-to-sav', dir: 'TO', amount: TFR_TO_SAVINGS,
    atlasAccountId: 'chequing-a', tfrReference: 'AB333',
    payee: 'AB333 TFR-TO',
  }),
  tfrLeg({
    id: 'tfr-sav-from-a', dir: 'FR', amount: TFR_TO_SAVINGS,
    atlasAccountId: 'savings', tfrReference: 'AB333',
    payee: 'AB333 TFR-FR',
  }),
  tx({
    id: 'card-1', amount: CARD_PMT, atlasAccountId: 'chequing-a',
    kindHint: 'card-payment', categoryLabel: 'Payment, Transfer',
    excludeFromTotals: true, payee: 'CAN TIRE MC',
  }),
  tx({
    id: 'pending-1', amount: PENDING_DEBIT, atlasAccountId: 'chequing-a',
    pending: true, pendingTreatment: 'presumed-settled-for-current-forecast',
    categoryLabel: 'Groceries',
  }),
  tx({
    id: 'weekly-grocery', amount: 8.12, atlasAccountId: 'chequing-b',
    categoryLabel: 'Groceries',
  }),
];

const representedActuals = [
  { id: 'hydro', date: PAYDAY, actual: BILL, postedOn: PAYDAY, transactionId: 'bill-1' },
];

console.log('=== A. External credit, ordinary debit, bill, refund, unknown ===');
{
  const plan = fixturePlan();
  const opts = movementOpts(coreTxs, { representedActuals });
  const set = F.postedAccountMovements(plan, 'chequing-a', WINDOW, opts);
  const independent = independentPostedChequingA(coreTxs, WINDOW, { representedActuals });
  ok(set && set.complete === true
      && set.completenessClaim === 'posted-window-complete'
      && set.accountId === 'chequing-a',
    'complete posted chequing-a movement set');
  ok(set.movements.length === independent.movements.length,
    'movement count matches independent reconstruction',
    `${set.movements.length} vs ${independent.movements.length}`);
  const credit = findMove(set, 'payroll-1');
  const grocery = findMove(set, 'grocery-1');
  const bill = findMove(set, 'bill-1');
  const refund = findMove(set, 'refund-1');
  const unknown = findMove(set, 'unknown-1');
  ok(credit && near(credit.amount, DALE) && credit.direction === 'inflow'
      && credit.classification === 'income'
      && set.movements.filter(row => row.id === 'payroll-1').length === 1,
    'external credit appears once as inflow, not invented twice');
  ok(grocery && near(grocery.amount, -GROCERY) && grocery.direction === 'outflow'
      && grocery.classification === 'spend' && grocery.categoryId === 'groceries',
    'ordinary debit appears once as posted outflow');
  ok(bill && near(bill.amount, -BILL) && bill.classification === 'bill'
      && bill.representedBill === true
      && set.movements.filter(row => row.id === 'bill-1').length === 1
      && !set.movements.some(row => row.id === 'hydro'),
    'settled bill debit appears once from the provider tx, not representedActuals');
  ok(refund && near(refund.amount, REFUND) && refund.direction === 'inflow'
      && refund.classification === 'refund',
    'refund/credit preserves inflow direction without invented income');
  ok(unknown && near(unknown.amount, -UNKNOWN_DEBIT)
      && unknown.direction === 'outflow'
      && unknown.classification === 'UNKNOWN'
      && unknown.categoryId == null,
    'unknown debit remains cash outflow with purpose UNKNOWN');
}

console.log('=== B. Scheduled-but-unsettled bill is not a cash movement ===');
{
  const plan = fixturePlan({
    bills: [{
      id: 'hydro', name: 'Hydro', amount: 199, day: 28, frequency: 'monthly',
      payingAccount: 'chequing-a',
    }],
  });
  const txs = [
    tx({
      id: 'grocery-1', amount: GROCERY, atlasAccountId: 'chequing-a',
      categoryLabel: 'Groceries',
    }),
  ];
  const set = F.postedAccountMovements(plan, 'chequing-a', WINDOW, movementOpts(txs));
  ok(set && set.complete === true
      && !set.movements.some(row => row.id === 'hydro' || row.classification === 'bill')
      && set.movements.length === 1
      && set.movements[0].id === 'grocery-1',
    'due-date bill schedule creates no chequing-a cash movement');
}

console.log('=== C. Internal transfers affect chequing-a once, not income/consumption ===');
{
  const plan = fixturePlan();
  const set = F.postedAccountMovements(
    plan, 'chequing-a', WINDOW, movementOpts(coreTxs, { representedActuals }));
  const toB = findMove(set, 'tfr-a-to-b');
  const fromB = findMove(set, 'tfr-a-from-b');
  const toSav = findMove(set, 'tfr-a-to-sav');
  ok(toB && near(toB.amount, -TFR_TO_B) && toB.internalTransfer === true
      && toB.classification === 'internal-transfer'
      && toB.counterpartAccountId === 'chequing-b'
      && toB.householdIncome === 0 && toB.householdConsumption === 0
      && !set.movements.some(row => row.id === 'tfr-b-from-a'),
    'chequing-a → chequing-b is one chequing-a outflow, not household consumption');
  ok(fromB && near(fromB.amount, TFR_FROM_B) && fromB.internalTransfer === true
      && fromB.classification === 'internal-transfer'
      && fromB.counterpartAccountId === 'chequing-b'
      && fromB.householdIncome === 0
      && !set.movements.some(row => row.id === 'tfr-b-to-a'),
    'chequing-b → chequing-a is one chequing-a inflow, not household income');
  ok(toSav && near(toSav.amount, -TFR_TO_SAVINGS) && toSav.internalTransfer === true
      && toSav.counterpartAccountId === 'savings'
      && toSav.householdConsumption === 0,
    'chequing-a → designated savings preserves internal-transfer semantics');
}

console.log('=== D. Pending cannot masquerade as posted ===');
{
  const plan = fixturePlan();
  const set = F.postedAccountMovements(
    plan, 'chequing-a', WINDOW, movementOpts(coreTxs, { representedActuals }));
  ok(!findMove(set, 'pending-1')
      && set.movements.every(row => row.pending === false && row.evidenceState === 'posted'),
    'pending grocery, even presumed-settled, is not a posted movement');
}

console.log('=== E. representedActual cannot duplicate the provider transaction ===');
{
  const plan = fixturePlan();
  const extraActuals = representedActuals.concat([
    { id: 'hydro', date: PAYDAY, actual: BILL, postedOn: PAYDAY, transactionId: 'bill-1' },
  ]);
  const set = F.postedAccountMovements(
    plan, 'chequing-a', WINDOW, movementOpts(coreTxs, { representedActuals: extraActuals }));
  ok(set.movements.filter(row => row.id === 'bill-1' || row.representedBill).length === 1
      && !set.movements.some(row => row.id === 'hydro'),
    'duplicate representedActuals rows do not add a second cash movement');
}

console.log('=== F. Rename-invariant; wrong account cannot enter ===');
{
  const plan = fixturePlan({ billsLabel: 'RENAMED PAYROLL CHEQUING 2026' });
  const renamed = F.postedAccountMovements(
    plan, 'chequing-a', WINDOW, movementOpts(coreTxs, { representedActuals }));
  const original = F.postedAccountMovements(
    fixturePlan(), 'chequing-a', WINDOW, movementOpts(coreTxs, { representedActuals }));
  const byLabel = F.postedAccountMovements(
    fixturePlan(), 'BILLS ACCOUNT', WINDOW, movementOpts(coreTxs, { representedActuals }));
  const other = F.postedAccountMovements(
    fixturePlan(), 'chequing-b', WINDOW, movementOpts(coreTxs, { representedActuals }));
  ok(renamed && original
      && renamed.movements.length === original.movements.length
      && renamed.movements.every((row, i) => row.id === original.movements[i].id
        && row.accountId === 'chequing-a'
        && near(row.amount, original.movements[i].amount)),
    'renamed display name produces identical chequing-a membership');
  ok(byLabel && byLabel.complete === false && byLabel.movements.length === 0
      && byLabel.reason === 'account-not-in-scope',
    'display name BILLS ACCOUNT cannot look up the movement set');
  ok(other && other.complete === false && other.movements.length === 0
      && other.reason === 'account-not-in-scope'
      && !other.movements.some(row => row.accountId === 'chequing-b'),
    'wrong account cannot enter the chequing-a movement set');
  ok(!renamed.movements.some(row => row.accountId === 'chequing-b'
      || row.id === 'weekly-grocery'),
    'chequing-b grocery is not a chequing-a movement');
}

console.log('=== G. Missing coverage fails closed; no balancing plug ===');
{
  const plan = fixturePlan();
  const missing = F.postedAccountMovements(plan, 'chequing-a', WINDOW, {});
  const truncated = F.postedAccountMovements(
    plan, 'chequing-a', WINDOW,
    movementOpts(coreTxs, { transactionCoverage: 'truncated', representedActuals }));
  const shortWindow = F.postedAccountMovements(
    plan, 'chequing-a', WINDOW,
    movementOpts(coreTxs, {
      coverageStart: '2026-08-29',
      coverageThrough: '2026-08-29',
      representedActuals,
    }));
  const unmapped = F.postedAccountMovements(
    plan, 'chequing-a', WINDOW,
    movementOpts(coreTxs.concat([
      tx({ id: 'ghost', amount: 5, atlasAccountId: null, accountRole: 'unmapped' }),
    ]), { representedActuals }));
  const duplicate = F.postedAccountMovements(
    plan, 'chequing-a', WINDOW,
    movementOpts(coreTxs.concat([
      tx({
        id: 'grocery-1', amount: GROCERY, atlasAccountId: 'chequing-a',
        categoryLabel: 'Groceries',
      }),
    ]), { representedActuals }));
  const complete = F.postedAccountMovements(
    plan, 'chequing-a', WINDOW, movementOpts(coreTxs, { representedActuals }));
  const independent = independentPostedChequingA(coreTxs, WINDOW, { representedActuals });
  const sum = roundCent(complete.movements.reduce((s, row) => s + row.amount, 0));
  const expectedSum = roundCent(independent.movements.reduce((s, row) => s + row.amount, 0));
  ok(missing && missing.complete === false && missing.movements.length === 0,
    'missing actuals fail closed rather than claiming completeness');
  ok(truncated && truncated.complete === false && truncated.movements.length === 0,
    'truncated posted coverage fails closed');
  ok(shortWindow && shortWindow.complete === false && shortWindow.movements.length === 0,
    'window not covered by the fetch fails closed');
  ok(unmapped && unmapped.complete === false && unmapped.movements.length === 0,
    'unmapped provider account fails closed');
  ok(duplicate && duplicate.complete === false && duplicate.movements.length === 0,
    'duplicate transaction identity fails closed');
  ok(complete.complete === true && near(sum, expectedSum)
      && !complete.movements.some(row => /plug|balancing|adjustment/i.test(String(row.id))),
    'complete set sums independent reconstruction; no balancing movement is manufactured');
}

console.log('=== H. Leftover, Current Balance, and Prepare Ahead are unchanged ===');
{
  const plan = fixturePlan();
  const transferOnly = [
    tfrLeg({
      id: 'tfr-a-to-b', dir: 'TO', amount: TFR_TO_B,
      atlasAccountId: 'chequing-a', tfrReference: 'AB111',
      payee: 'AB111 TFR-TO',
    }),
    tfrLeg({
      id: 'tfr-b-from-a', dir: 'FR', amount: TFR_TO_B,
      atlasAccountId: 'chequing-b', tfrReference: 'AB111',
      payee: 'AB111 TFR-FR',
    }),
  ];
  const without = recommend(plan);
  const withMovements = recommend(plan, movementOpts(transferOnly));
  const a = operatingSnapshot(without);
  const b = operatingSnapshot(withMovements);
  const packetOnView = withMovements.defaultView
    && withMovements.defaultView.postedBillsAccountMovements;
  ok(without.defaultView.postedBillsAccountMovements
      && without.defaultView.postedBillsAccountMovements.complete === false,
    'without actuals the movement set is unavailable');
  ok(packetOnView && packetOnView.complete === true
      && packetOnView.accountId === 'chequing-a'
      && packetOnView.movements.some(row => row.id === 'tfr-a-to-b'),
    'recommend attaches the Forecast-owned chequing-a movement packet');
  ok(snapshotsEqual(a, b),
    'leftover, Current Balance, and Prepare Ahead do not move when the packet is attached');
  ok(near(a.currentBalance, BILLS_OPENING)
      && !near(a.currentBalance, POOLED)
      && !near(a.leftover, BILLS_OPENING),
    'Current Balance is posted hub chequing-a; leftover is not chequing-a cash');
}

console.log('=== I. Page does not calculate the movement set ===');
{
  const forecastSrc = read('public/forecast.js');
  const { pageScriptsMatching } = require('./lib/page-scripts');
  const hits = pageScriptsMatching(/postedAccountMovements/, /postedBillsAccountMovements/);
  ok(hits.length === 0,
    'no page script (classic or Stack) reprints or calculates posted chequing-a movements', hits.join(', ') || 'none');
  ok(/function postedAccountMovements\(/.test(forecastSrc)
      && /POSTED_ACCOUNT_MOVEMENTS_ACCOUNT_ID = 'chequing-a'/.test(forecastSrc)
      && /POSTED_ACCOUNT_MOVEMENTS_CLAIM = 'posted-window-complete'/.test(forecastSrc)
      && /tx\.pending === true/.test(forecastSrc),
    'Forecast owns the posted chequing-a movement set and pending-exclusion');
  filesUnchanged('posted chequing-a movements');
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nAll posted chequing-a movement evidence checks passed');
