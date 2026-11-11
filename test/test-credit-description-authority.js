'use strict';
/* Synthetic observation -> real server overlay -> Forecast.creditAccounts.
 * Monetary expectations are fixed independent fixture arithmetic. The Credit
 * page that rendered these rows, and its description-prose rule, were removed
 * under #822; the file name is kept so the suite identity does not move.
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Forecast = require('../public/forecast.js');
const Live = require('../scripts/live-plan.js');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const OPENING = '2026-03-10';
const CURRENT = '2026-03-11';
const canonical = {
  meta: { asOf: OPENING }, revolvingExtra: [],
  debts: [{ id: 'card-a', label: 'Synthetic card', secured: false,
    balance: 100, pending: 0, pendingUnknown: false, limit: 1000,
    rate: 20, confidence: 'verified',
    structure: 'Revolving credit. Posted $100.00 + $0.00 pending. Activity: $123.45 in purchases.' }],
  plan: {
    windowDays: 91, opening: { asOf: OPENING },
    defaults: { scenario: 'expected', targetBuffer: 0, extraDebtMonthly: 0 },
    startingCash: { breakdown: [
      { id: 'chequing-a', label: 'Synthetic bills', value: 500 },
      { id: 'chequing-b', label: 'Synthetic weekly', value: 200 },
      { id: 'savings', label: 'Synthetic reserve', value: 50 },
    ] },
    income: [{ id: 'pay', label: 'Synthetic pay', frequency: 'biweekly',
      anchor: '2026-03-06', amount: 1000, confidence: 'confirmed' }],
    obligations: [{ id: 'card-a', debtId: 'card-a', effect: 'payment',
      label: 'Synthetic minimum', frequency: 'monthly', day: 15,
      amount: 10, confidence: 'estimated', payingAccount: 'chequing-a' }],
    bills: [], commitments: [],
  },
};
const map = {
  schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'fixture',
  owns: 'Synthetic fixture identities only.', does_not_own: 'Financial facts or write authority.',
  mappings: [
    { providerAccountId: '9001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
    { providerAccountId: '9002', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
    { providerAccountId: '9003', canonical: { collection: 'cash', id: 'savings' }, atlasRole: 'household-cash' },
    { providerAccountId: '9004', canonical: { collection: 'debts', id: 'card-a' }, atlasRole: 'revolving-credit' },
  ],
};
function payload() {
  return {
    provider: 'lunchmoney', fetchedAt: CURRENT + 'T18:00:00.000Z',
    pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false, startDate: null, endDate: null },
    accounts: [500, 200, 50, 140].map((balance, i) => ({
      id: 9001 + i, name: 'Synthetic account ' + i,
      type: i === 3 ? 'credit' : 'cash',
      subtype: i === 3 ? 'credit_card' : 'checking', balance,
      currency: 'cad', updated_at: CURRENT + 'T17:55:00.000Z', balance_last_update: CURRENT + 'T17:55:00.000Z',
      ...(i === 3 ? { credit_limit: 1000 } : {}),
    })),
    transactions: [{ id: 9901, account_id: 9004, date: CURRENT,
      amount: 25, payee: 'Synthetic purchase', is_pending: true }],
  };
}

// The Credit page that printed these rows was removed under #822. The rows
// Forecast returns for the served state are checked directly.
function render(data) {
  const before = JSON.stringify(data);
  const accounts = Forecast.creditAccounts(data.plan, data.debts, data.meta.asOf, {
    extraFacilities: data.revolvingExtra, debts: data.debts,
    currentPeriodActuals: data.liveOverlay && data.liveOverlay.applied === true ? data.liveOverlay.currentPeriodActuals : null,
  });
  assert.equal(JSON.stringify(data), before, 'reading credit rows must not mutate served state');
  return JSON.parse(JSON.stringify(accounts));
}
function checkDates(accounts, asOf) {
  assert.equal(accounts.asOf, asOf, 'credit rows keep the served financial as-of');
  const next = accounts.cards[0].nextPayment;
  assert.deepEqual([next.date, next.amount, next.confidence], ['2026-03-15', 10, 'estimated']);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-credit-description-'));
  const fixturePath = path.join(dir, 'payload.json');
  const mapPath = path.join(dir, 'map.json');
  const before = JSON.stringify(canonical);
  const canonicalBytes = fs.readFileSync(path.join(ROOT, 'data.json'));
  const snapshots = () => fs.readdirSync(path.join(ROOT, 'snapshots')).sort()
    .filter(file => file.endsWith('.json'))
    .map(file => [file, fs.readFileSync(path.join(ROOT, 'snapshots', file)).toString('base64')]);
  const snapshotBytes = snapshots();
  fs.writeFileSync(mapPath, JSON.stringify(map));
  const serve = async observation => {
    fs.writeFileSync(fixturePath, JSON.stringify(observation));
    return Live.applyForServer(canonical, {
      ATLAS_LIVE_OVERLAY: 'fixture', ATLAS_LIVE_OVERLAY_FIXTURE: fixturePath,
      ATLAS_LIVE_OVERLAY_MAP: mapPath,
    });
  };
  try {
    const served = await serve(payload());
    assert.equal(served.liveOverlay.applied, true, 'real server overlay must apply');
    assert.equal(served.meta.asOf, CURRENT);
    assert.equal(served.debts[0].balance, 140);
    assert.equal(served.debts[0].pending, 25);
    assert.equal(served.debts[0].structure, canonical.debts[0].structure, 'overlay leaves dated prose untouched');
    const output = render(served);
    const card = output.cards[0];
    assert.deepEqual([card.balance, card.pending, card.pendingUnknown], [140, 25, false]);
    assert.equal(card.available, 835, '1000 - 140 - 25 = 835 by hand');
    assert.equal(card.confidence, 'verified');
    checkDates(output, CURRENT);
    const again = await serve(payload());
    assert.deepEqual(render(again), output, 'same refresh and same read are idempotent');
    const changed = payload();
    changed.accounts[3].balance = 160;
    changed.transactions[0].amount = 30;
    const refreshed = render(await serve(changed)).cards[0];
    assert.deepEqual([refreshed.balance, refreshed.pending, refreshed.available], [160, 30, 810], '1000 - 160 - 30 = 810 by hand');

    // No overlay is still an explicitly dated opening, never fetchedAt-as-of.
    const dated = render(await Live.applyForServer(canonical, { ATLAS_LIVE_OVERLAY: 'off' }));
    assert.deepEqual([dated.cards[0].balance, dated.cards[0].available], [100, 900], '1000 - 100 - 0 = 900 by hand');
    checkDates(dated, OPENING);

    const stale = payload();
    stale.accounts.forEach(row => { row.updated_at = '2026-03-09T17:55:00.000Z'; row.balance_last_update = '2026-03-09T17:55:00.000Z'; });
    const missing = payload();
    missing.accounts = missing.accounts.filter(row => row.id !== 9001);
    const unknown = payload();
    unknown.pendingCoverage = null;
    unknown.transactions = [];
    for (const [label, observation, reason] of [
      ['stale', stale, /stale-live-cash-evidence/],
      ['missing', missing, /missing-live-cash-evidence/],
      ['unknown pending', unknown, /pending-freshness-unproven/],
    ]) {
      const fallback = await serve(observation);
      assert.equal(fallback.liveOverlay.applied, false, label + ' must fail closed');
      assert.match(fallback.liveOverlay.reason, reason);
      assert.equal(fallback.meta.asOf, OPENING, label + ' must keep dated as-of');
      assert.equal(fallback.debts[0].balance, 100);
      const output = render(fallback);
      assert.deepEqual([output.cards[0].balance, output.cards[0].pending], [100, 0], label + ' keeps the dated opening, not 140 / 25');
      checkDates(output, OPENING);
    }

    const incomplete = JSON.parse(before);
    incomplete.debts[0].pending = null;
    incomplete.debts[0].pendingUnknown = true;
    const postedUnknownPending = render(incomplete).cards[0];
    assert.deepEqual([postedUnknownPending.balance, postedUnknownPending.pending, postedUnknownPending.pendingUnknown, postedUnknownPending.available],
      [100, null, true, null], 'unknown pending is not $0 and withholds available credit');
    incomplete.debts[0].balance = null;
    const unknownRow = render(incomplete).cards[0];
    assert.deepEqual([unknownRow.balance, unknownRow.pendingUnknown, unknownRow.available], [null, true, null],
      'an unknown balance stays Unknown, never $0.00 or the old $100.00');

    assert.equal(JSON.stringify(canonical), before, 'refreshes must not mutate canonical input');
    assert.deepEqual(fs.readFileSync(path.join(ROOT, 'data.json')), canonicalBytes, 'canonical file bytes unchanged');
    assert.deepEqual(snapshots(), snapshotBytes, 'historical snapshot bytes unchanged');
    console.log('PASS Credit rows after the server overlay: overlay, fallback, unknowns, dates, refresh, numeric authority and no mutation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
