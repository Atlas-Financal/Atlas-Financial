'use strict';
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const View = require('../public/budget-card-movements');
const fx = require('./fixtures/card-posted-period-movement-data');
const { copy } = fx;
let checks = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const publish = x => F.cardPeriodMovements(x.plan, x.debts, x.asOf, x.window,
  { currentPeriodActuals: x.packet, cardPeriodBalanceEvidence: x.balanceEvidence });
const movement = (x, id = 'travelvisa') => publish(x).cards.find(c => c.id === id).postedMovement;
const x = fx.fixture(), before = JSON.stringify(x);
// Hand-worked signed cents, independent of the publication function.
eq(movement(x)?.amount, (17240 + 6375 - 10000 - 3500 + 625) / 100,
  'posted charges, payment, refund and interest; no saved endpoints required');
eq(movement(x, 'cashback').amount, (11420 - 25000) / 100, 'card payment counted only on card side');
eq(movement(x, 'tdcc').amount, 0, 'positively covered empty ledger is known zero');
eq(movement(x, 'tdcc').direction, 'flat', 'known zero is flat');
eq(movement(x).trust, 'calculated', 'Forecast calculates, never promotes to verified');
eq(movement(x).completeness, 'complete', 'qualified transaction evidence');
for (const id of ['triangle', 'mbna']) eq(movement(x, id).amount, null, id + ' has no positive transaction sync evidence');
eq(publish(x).cards[0].netChange.amount, null, 'endpoint reconciliation remains unavailable independently');
eq(JSON.stringify(x), before, 'publication is pure');
eq(publish(x), publish(x), 'repeat refresh is deterministic, not cumulative');

for (const [name, change] of [
  ['missing packet', y => { y.packet = null; }],
  ['stale observation', y => { y.packet.observationAsOf = '2026-08-19'; }],
  ['missing collection', y => { delete y.packet.transactions; }],
  ['unreadable collection', y => { y.packet.transactions = {}; }],
  ['unreadable row', y => { y.packet.transactions.push(null); }],
  ['unscoped malformed row', y => { y.packet.transactions.push({}); }],
  ['incomplete stamp', y => { y.packet.transactionCoverage = 'incomplete'; }],
  ['contradictory stamp', y => { y.packet.transactionCoverage = { complete: true, truncated: true }; }],
  ['missing declared query', y => { delete y.packet.transactionWindow; }],
  ['unproven query', y => { delete y.packet.transactionWindow.complete; }],
  ['continued query', y => { y.packet.transactionWindow.hasMore = true; }],
  ['truncated query', y => { y.packet.transactionWindow.truncated = true; }],
  ['short query', y => { y.packet.transactionWindow.startDate = '2026-08-15'; }],
  ['short through', y => { y.packet.transactionWindow.endDate = '2026-08-19'; }],
  ['incomplete pending evidence', y => { y.packet.pendingCoverage = 'unknown'; }],
  ['missing sync list', y => { delete y.packet.syncEvidence; }],
  ['missing own sync', y => { y.packet.syncEvidence = y.packet.syncEvidence.filter(r => r.id !== 'travelvisa'); }],
  ['failed own sync', y => { y.packet.syncEvidence[0].syncEvidence = 'failed'; }],
  ['absent own sync', y => { y.packet.syncEvidence[0].syncEvidence = 'absent'; }],
  ['wrong role', y => { y.packet.syncEvidence[0].role = 'household-cash'; }],
  ['no positive sync field', y => { y.packet.syncEvidence[0].fields.last_fetch = false; }],
  ['duplicate sync identity', y => { y.packet.syncEvidence.push(copy(y.packet.syncEvidence[0])); }],
  ['missing amount', y => { delete y.packet.transactions[0].amount; }],
  ['fractional cent', y => { y.packet.transactions[0].amount = 172.401; }],
  ['missing date', y => { delete y.packet.transactions[0].date; }],
  ['unknown posting', y => { y.packet.transactions[0].savingsPostingEvidence = 'unknown'; }],
  ['missing posting', y => { delete y.packet.transactions[0].savingsPostingEvidence; }],
  ['contradictory posting', y => { y.packet.transactions[0].savingsPostingEvidence = 'pending'; }],
  ['wrong row role', y => { y.packet.transactions[0].accountRole = 'household-cash'; }],
  ['foreign currency', y => { y.packet.transactions[0].currency = 'usd'; }],
  ['duplicate identity', y => { y.packet.transactions.push(copy(y.packet.transactions[0])); }],
  ['conflicting account aliases', y => { y.packet.transactions[0].account = 'cashback'; }],
  ['unconfirmed source row', y => { y.packet.cardCoverageUnconfirmed.push({ reason: 'unconfirmed' }); }],
]) {
  const y = copy(x); change(y);
  eq(movement(y)?.amount, null, name + ': unavailable, never a partial number');
}
const failed = copy(x); failed.packet.syncEvidence[0].syncEvidence = 'failed';
eq(movement(failed, 'cashback').amount, -135.80, 'another card remains independently publishable');
eq(publish(failed).cards.map(c => c.reportedBalance), publish(x).cards.map(c => c.reportedBalance),
  'movement uncertainty never changes balances');
const arbitraryEndpoints = copy(x); arbitraryEndpoints.balanceEvidence = require('./fixtures/card-period-movements-data').fixture().balanceEvidence;
arbitraryEndpoints.balanceEvidence.cards[0].closing.amount = 9999;
eq(movement(arbitraryEndpoints).amount, 107.40, 'arbitrary endpoints do not source transaction movement');
const bounds = copy(x), template = copy(x.packet.transactions[0]);
bounds.packet.transactions.push(...[
  { ...template, id: 'first', coverageRef: 'first', date: x.window.start, amount: 1 },
  { ...template, id: 'today', coverageRef: 'today', date: x.asOf, amount: 2 },
  { ...template, id: 'before', coverageRef: 'before', date: '2026-08-13', amount: 400 },
  { ...template, id: 'tomorrow', coverageRef: 'tomorrow', date: '2026-08-21', amount: 800 },
]);
eq(movement(bounds).amount, 110.40, 'inclusive period start and through; excludes prior/future activity');
const future = copy(x); future.window = F.spendingCycle(future.plan, '2026-08-28');
eq(movement(future).amount, null, 'future never borrows current ledger');
const pending = copy(x); pending.packet.transactions.find(t => t.pending).amount = 999;
eq(movement(pending).amount, 107.40, 'pending amount never added');

// Real normalization/sanitizer/overlay path with invented provider data.
const base = require('./fixtures/budget-surface-data');
const Live = require('../scripts/live-plan');
function observed(rows, mutate = () => {}) {
  const data = base.canonical(), payload = base.payload();
  payload.accounts.find(a => a.id === 2001).last_fetch = payload.fetchedAt;
  payload.transactions.push(...copy(rows));
  mutate(payload);
  return Live.fromObservation({ data, payload, accountMap: base.map, identity: base.identity }).data;
}
const raw = (id, amount, extra = {}) => ({ id, account_id: 2001, date: '2026-08-18',
  amount, currency: 'cad', is_pending: false, category_id: 11, payee: 'Invented card activity', ...extra });
const observedMovement = d => F.cardPeriodMovements(d.plan, d.debts, '2026-08-20',
  F.spendingCycle(d.plan, '2026-08-20'), { currentPeriodActuals: d.liveOverlay.currentPeriodActuals })
  .cards.find(c => c.id === 'travelvisa').postedMovement;
const posted = raw(99001, 50), credit = raw(99002, -20), authorization = raw(99003, 15, { is_pending: true });
eq(observedMovement(observed([posted, credit, authorization])).amount, 30, 'real path: posted signed sum only');
eq(observedMovement(observed([posted, credit, authorization, { ...authorization, is_pending: false }])).amount,
  45, 'real path: pending-to-posted successor counted once');
eq(observedMovement(observed([posted, credit])).amount, 30, 'repeat refresh rebuilds from rows');
const parent = raw(99010, 30, { is_group: true });
eq(observedMovement(observed([parent, raw(99011, 10, { parent_id: 99010 }), raw(99012, 20, { parent_id: 99010 })])).amount,
  30, 'real path: split parts once, parent excluded');
eq(observedMovement(observed([parent, raw(99011, 10, { parent_id: 99010 })])).amount,
  null, 'real path: incomplete split cannot publish partial total');
for (const [name, rows, mutate] of [
  ['duplicate', [posted, posted]], ['missing amount', [raw(99001, null)]],
  ['missing date', [raw(99001, 50, { date: null })]],
  ['unknown posting', [raw(99001, 50, { is_pending: undefined })]],
  ['incomplete query', [posted], p => { p.transactionWindow.complete = false; }],
  ['provider failure', [posted], p => { p.accounts.find(a => a.id === 2001).status = 'error'; }],
  ['no sync fields', [], p => { delete p.accounts.find(a => a.id === 2001).last_fetch; }],
]) eq(observedMovement(observed(rows, mutate)).amount, null, 'real path: ' + name);
eq(observedMovement(observed([])).amount, 0, 'real path: complete empty plus positive own sync proves zero');
eq(observedMovement(observed([posted], p => { p.accounts.find(a => a.id === 2001).last_fetch = '2025-01-02T12:00:00Z'; })).amount,
  50, 'owner rule: sync age alone is informational; no new cutoff');

const format = { money: n => '$' + n.toFixed(2), date: d => d };
const face = (p, id) => View.html(p, format).split('data-budget-card-toggle="' + id + '"')[1].split('</button>')[0];
eq(face(publish(x), 'travelvisa').includes('+$107.40 this period'), true, 'UI copies positive publication');
eq(face(publish(x), 'cashback').includes('−$135.80 this period'), true, 'UI copies negative publication');
eq(face(publish(x), 'tdcc').includes('No change this period'), true, 'UI known zero wording');
eq(/data-card-posted-movement="unavailable"[^>]*>Unavailable<\/small>/.test(face(publish(x), 'triangle')), true, 'UI unavailable wording');
const tampered = publish(x); tampered.cards[0].postedMovement.trust = 'estimated';
eq(/data-card-posted-movement="unavailable"[^>]*>Unavailable<\/small>/.test(face(tampered, 'travelvisa')), true, 'UI rejects wrong trust');
for (const [name, mutate] of [
  ['incomplete', r => { r.completeness = 'incomplete'; }],
  ['unresolved reason', r => { r.reasons = ['unconfirmed']; }],
  ['missing reasons', r => { delete r.reasons; }],
  ['nonfinite', r => { r.magnitude = Infinity; }],
  ['negative magnitude', r => { r.magnitude = -1; }],
  ['unknown direction', r => { r.direction = '<script>'; }],
  ['false flat', r => { r.direction = 'flat'; }],
]) {
  const p = publish(x); mutate(p.cards[0].postedMovement);
  eq(/data-card-posted-movement="unavailable"[^>]*>Unavailable<\/small>/.test(face(p, 'travelvisa')), true, 'UI rejects ' + name);
}
const duplicateRef = copy(x);
duplicateRef.packet.transactions.push({ ...template, id: 'other-id' });
eq(movement(duplicateRef).amount, null, 'repeated native reference never counts twice');
console.log('PASS posted card period movement: ' + checks + ' assertions');
