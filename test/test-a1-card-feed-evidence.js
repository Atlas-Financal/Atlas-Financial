'use strict';
const assert = require('node:assert/strict');
const F = require('../public/forecast'), View = require('../public/budget-card-movements');
const fx = require('./fixtures/card-posted-period-movement-data');
let checks = 0;
const eq = (a, b, why) => { assert.deepEqual(a, b, why); checks++; };
const publish = x => F.cardPeriodMovements(x.plan, x.debts, x.asOf, x.window,
  { currentPeriodActuals: x.packet, liveOverlay: x.overlay });
const row = (x, id = 'travelvisa') => publish(x).cards.find(c => c.id === id).postedMovement;
const own = (x, id = 'travelvisa') => x.overlay.overlays.find(r => r.locator === 'debts:' + id);
const face = (x, id = 'travelvisa') => View.html(publish(x), { money: n => '$' + n.toFixed(2), date: d => d })
  .split('data-budget-card-toggle="' + id + '"')[1].split('</button>')[0];
const x = fx.fixture();
const missing = fx.copy(x); missing.overlay.overlays = missing.overlay.overlays.filter(r => r.locator !== 'debts:travelvisa');
eq(row(missing).amount, null, 'A1: positive contact without own dated observation is unknown');
for (const day of ['2026-08-20', '2026-08-19', '2026-08-18', '2025-01-02']) {
  const y = fx.copy(x); own(y).evidenceDate = day;
  eq(row(y).amount, 107.40, 'age alone never withholds: ' + day);
  eq(row(y).trust, 'calculated', 'no trust promotion: ' + day);
  eq(row(y).observation, { kind: 'provider-balance', date: day, showDate: day < '2026-08-19' }, 'typed own balance date: ' + day);
  eq(face(y).includes('balance as of ' + day), day < '2026-08-19', 'only older dates print: ' + day);
}
const idle = fx.copy(x); own(idle, 'tdcc').evidenceDate = '2025-01-02';
eq(row(idle, 'tdcc').amount, 0, 'old known empty ledger retains calculated zero');
eq(face(idle, 'tdcc').includes('No change this period · balance as of 2025-01-02'), true, 'known dated zero stays visible');
const payments = fx.copy(x); own(payments).evidenceDate = '2026-08-01';
payments.packet.transactions = payments.packet.transactions.filter(tx => tx.account !== 'travelvisa' || tx.amount < 0);
eq(row(payments).amount, -135, 'both posted payment and refund remain counted after balance evidence day');
eq(row(payments).observation.date, '2026-08-01', 'later credits do not renew date');
eq(face(payments).includes('balance as of 2026-08-01'), true, 'date is explicitly balance evidence, never transaction-through');
for (const [name, mutate] of [
  ['no overlay', y => { y.overlay = null; }],
  ['unapplied overlay', y => { y.overlay.applied = false; }],
  ['unreadable observations', y => { y.overlay.overlays = {}; }],
  ['missing date', y => { delete own(y).evidenceDate; }],
  ['invalid date', y => { own(y).evidenceDate = '2026-02-30'; }],
  ['future date', y => { own(y).evidenceDate = '2026-08-21'; }],
  ['amount disagreement', y => { own(y).proposedValue += 1; }],
  ['duplicate own row', y => { y.overlay.overlays.push(fx.copy(own(y))); }],
  ['canonical fallback', y => { y.debts[0].evidenceDate = y.asOf; y.overlay.overlays = []; }],
]) {
  const y = fx.copy(x); mutate(y);
  eq(row(y).amount, null, name + ': missing/unqualified evidence is unavailable');
  eq(row(y, 'cashback').amount, name === 'no overlay' || name === 'unapplied overlay'
    || name === 'unreadable observations' || name === 'canonical fallback' ? null : -135.80, name + ': independent scope');
}
const earlier = fx.copy(x); own(earlier).evidenceDate = '2026-08-01';
earlier.packet.lastSuccessfulSyncAt = '2026-08-20T18:00:00Z';
eq(row(earlier).observation.date, '2026-08-01', 'aggregate successful contact never replaces own balance date');
earlier.packet.transactions.find(tx => tx.pending).date = '2026-08-20';
eq(row(earlier).observation.date, '2026-08-01', 'pending activity never renews balance evidence');
const prior = JSON.stringify(earlier);
eq(publish(earlier), publish(earlier), 'refresh recomputes deterministically');
eq(JSON.stringify(earlier), prior, 'no mutation');
// Existing supported observer -> overlay -> Forecast path; no provider access.
const b = require('./fixtures/budget-surface-data'), L = require('../scripts/live-plan');
for (const changed of [false, true]) {
  const data = b.canonical(), payload = b.payload(), account = payload.accounts.find(r => r.id === 2001);
  account.last_fetch = payload.fetchedAt;
  if (changed) account.balance = 2015;
  const d = L.fromObservation({ data, payload, accountMap: b.map, identity: b.identity }).data;
  const p = d.liveOverlay.currentPeriodActuals;
  const m = F.cardPeriodMovements(d.plan, d.debts, p.observationAsOf, F.spendingCycle(d.plan, p.observationAsOf),
    { currentPeriodActuals: p, liveOverlay: d.liveOverlay }).cards.find(c => c.id === 'travelvisa').postedMovement;
  eq(m.amount, changed ? 0 : null, 'real path: ' + (changed ? 'known current idle card is zero' : 'MATCH publishes no own date; unknown'));
}
const oldData = b.canonical(), oldPayload = b.payload(), oldAccount = oldPayload.accounts.find(r => r.id === 2001);
oldAccount.balance = 2015; oldAccount.balance_as_of = '2026-08-01T12:00:00Z'; oldAccount.last_fetch = oldPayload.fetchedAt;
const old = L.fromObservation({ data: oldData, payload: oldPayload, accountMap: b.map, identity: b.identity }).data;
const oldPacket = old.liveOverlay.currentPeriodActuals;
const oldRow = F.cardPeriodMovements(old.plan, old.debts, oldPacket.observationAsOf,
  F.spendingCycle(old.plan, oldPacket.observationAsOf), { currentPeriodActuals: oldPacket, liveOverlay: old.liveOverlay })
  .cards.find(c => c.id === 'travelvisa').postedMovement;
eq(oldRow.amount, null, 'real path: a refused different balance cannot date the displayed canonical balance');
eq(oldRow.observation, undefined, 'no date association is invented from a refusal without a matching value');
for (const change of [
  y => { y.overlay.refused[0].fact = 'pending'; },
  y => { y.overlay.refused[0].reason = 'unknown-value'; },
  y => { y.overlay.refused[0].evidenceDate = '2026-08-21'; },
  y => { y.overlay.refused.push(fx.copy(y.overlay.refused[0])); },
]) {
  const y = fx.copy(x); y.overlay.overlays = y.overlay.overlays.filter(r => r.locator !== 'debts:travelvisa');
  y.overlay.refused = [{ locator: 'debts:travelvisa', fact: 'posted-balance', reason: 'stale-not-current', evidenceDate: '2026-08-01' }];
  change(y); eq(row(y).amount, null, 'unqualified refusal cannot supply an observation date');
}
console.log('PASS A1 own dated evidence: ' + checks + ' assertions');
