'use strict';
// Independent Systems findings, using invented inputs and literal cents.
const assert = require('node:assert/strict'), test = require('node:test');
const path = require('node:path');
const root = process.env.ATLAS_SAVINGS_REVIEW_ROOT || path.resolve(__dirname, '..');
const F = require(path.join(root, 'public/forecast'));
const Inventory = require(path.join(root, 'public/savings-inventory'));
const fx = require('./fixtures/chronological-savings-data');
const transfer = require('./fixtures/savings-daily-allocation-contract').transfer;
const clone = value => JSON.parse(JSON.stringify(value));
// Independent planning-date regression: invented stock 30 + 89 = 119.
// Dating the existing 37 travel estimate between 60 and 50 gives 60/37/22.
function planningTargetFixture(dated) {
  const input = fx.ledger();
  input.plan.savingsEarmarks.pools.forEach(pool => { pool.goalRefs = []; });
  input.plan.commitments = [
    { id: 'early', label: 'Invented earlier cost', date: '2026-10-09', amount: 60,
      confidence: 'confirmed', sinkingFund: true },
    { id: 'weekend-trip', label: 'Invented tournament travel', amount: 37,
      when: 'timing TBD', confidence: 'estimated', sinkingFund: true },
    { id: 'later', label: 'Invented later cost', date: '2027-03-01', amount: 50,
      confidence: 'confirmed', sinkingFund: true },
  ];
  if (dated) input.plan.commitments[1].date = '2027-02-12';
  return input;
}
function targetPacket(input) {
  const before = JSON.stringify(input);
  const packet = F.recommend(input.plan, input.asOf, { ...input.opts, weeklyVariable: 0, debts: [] }).savingsFunding;
  assert.equal(JSON.stringify(input), before, 'a target cannot mutate money, policy or settlement');
  return packet;
}
test('dating an existing travel estimate admits it once to combined chronological backing', () => {
  const undated = targetPacket(planningTargetFixture(false));
  assert.equal(undated.stock.amount, 119);
  assert.equal(undated.backing.status, 'unavailable');
  assert.equal(undated.unresolved.find(row => row.id === 'weekend-trip').needed, 37);
  assert.ok(undated.backing.items.every(row => row.saved === null));
  const input = planningTargetFixture(true), packet = targetPacket(input);
  assert.equal(packet.backing.status, 'ready');
  assert.deepEqual(packet.backing.items.map(row => [row.id, row.date, row.needed, row.saved]), [
    ['early', '2026-10-09', 60, 60], ['weekend-trip', '2027-02-12', 37, 37], ['later', '2027-03-01', 50, 22],
  ]);
  assert.equal(packet.backing.unallocated, 0);
  assert.equal(6000 + 3700 + 2200, 11900, 'independent cents conserve the one observed pot');
  assert.equal(packet.backing.items.find(row => row.id === 'weekend-trip').trust, 'estimated');
  assert.deepEqual(F.expandEvents(input.plan, input.asOf, '2027-03-01', input.opts)
    .filter(row => row.id === 'weekend-trip').map(row => [row.date, row.amount]), [['2027-02-12', -37]]);
  assert.equal(packet.period.actualSaved, null);
  assert.equal(packet.backing.actualTransferred, null);
  assert.equal(packet.moneyMovementPermission, 'not-granted');
});
for (const gate of ['card-coverage', 'external-row']) test('dating a target retains the independent ' + gate + ' proposal gate', () => {
  const input = planningTargetFixture(true);
  if (gate === 'card-coverage') input.opts.currentPeriodActuals.cardCoverageRequired = true;
  else input.opts.currentPeriodActuals.transactions.push({ id: 'invented-external', date: input.asOf,
    amount: 1, pending: false, currency: 'CAD', atlasAccountId: 'invented-external', accountRole: 'business-excluded' });
  const packet = targetPacket(input);
  assert.equal(packet.stock.amount, 119);
  assert.equal(packet.backing.status, 'ready');
  assert.deepEqual(packet.backing.items.map(row => row.saved), [60, 37, 22]);
  assert.equal(packet.status, 'unavailable');
  assert.equal(packet.period.proposal, null);
  assert.equal(packet.timeline.status, 'unavailable');
  assert.match(packet.reason, gate === 'card-coverage' ? /Confirm the card-coverage opening/ : /unavailable date, currency, amount or account identity/);
});
test('a usable planning target does not resolve pending savings evidence', () => {
  const input = planningTargetFixture(true);
  input.plan.savingsPoolObservation.accounts[0].pendingState = 'unresolved';
  const packet = targetPacket(input);
  assert.equal(packet.stock.amount, 119);
  assert.equal(packet.backing.status, 'unavailable');
  assert.deepEqual(packet.backing.items.map(row => row.saved), [60, 37, 22], 'pending movement does not erase reported earmarks');
  assert.equal(packet.goalAllocation.evidenceTrust, 'provider-reported');
  assert.equal(packet.period.proposal, null);
});
function ready() {
  const data = fx.data('ready');
  const advice = F.recommend(data.plan, data.meta.asOf, { weeklyVariable: 40, ...data.liveOverlay });
  return { data, advice, context: { plan: data.plan, asOf: data.meta.asOf, advice } };
}
test('grouped calculated backing retains provenance and unknown actual savings', () => {
  const { advice } = ready(), group = advice.savingsFunding.schedule.groups[0];
  assert.equal(group.backingBasis, 'policy-derived-observed-backing');
  assert.equal(group.actualSaved, null);
  assert.equal(group.protectedNow, 95);
});
const invalid = {
  missing: advice => { delete advice.savingsFunding; },
  stale: advice => { advice.savingsFunding.asOf = '2026-10-06'; },
  rows: advice => { advice.savingsFunding.rows = {}; },
  currency: advice => { advice.savingsFunding.currency = 'USD'; },
  period: advice => { advice.savingsFunding.period.start = '2026-10-16'; },
  allocations: advice => { advice.savingsFunding.period.allocations = null; },
  views: advice => { advice.savingsFunding.periodViews = {}; },
  schedule: advice => { advice.savingsFunding.schedule.asOf = '2026-10-06'; },
};
for (const [name, mutate] of Object.entries(invalid)) test(name + ' publication holds every current consumer', () => {
  const { advice, context } = ready(); mutate(advice);
  assert.equal(F.savingsFundingPublication(advice.savingsFunding, context), null);
  const html = Inventory.html(advice.savingsFunding, context);
  assert.match(html, /Shared savings evidence is unavailable/);
  assert.doesNotMatch(html, /95\.00/);
});
test('current ready, projected and pending publications keep their independent trust', () => {
  const { advice, context } = ready();
  assert.equal(F.savingsFundingPublication(advice.savingsFunding, context), advice.savingsFunding);
  assert.match(Inventory.html(advice.savingsFunding, context), /95\.00/);
  assert.doesNotMatch(Inventory.html(advice.savingsFunding), /95\.00/, 'rendering needs independent opening context');
  const next = advice.payPeriodViews.find(row => row.timelineRole === 'next');
  const selected = F.savingsFundingPublication(advice.savingsFunding, { ...context, periodId: next.id });
  assert.equal(selected.period.actualSaved, null);
  assert.ok(selected.rows.every(row => row.saved === null));
  const data = fx.data('pending');
  const pending = F.recommend(data.plan, data.meta.asOf, { weeklyVariable: 40, ...data.liveOverlay });
  assert.equal(F.savingsFundingPublication(pending.savingsFunding, { asOf: data.meta.asOf, advice: pending }), pending.savingsFunding);
  assert.equal(pending.savingsFunding.stock.amount, 119);
  assert.equal(pending.savingsFunding.backing.status, 'unavailable');
  assert.match(Inventory.html(pending.savingsFunding, { asOf: data.meta.asOf, advice: pending }), /119\.00/);
});
function payments() {
  const i = fx.ledger();
  i.plan.commitments = [
    { id: 'cash-a', label: 'Invented first', date: '2026-10-09', amount: 12.13, confidence: 'confirmed', sinkingFund: true },
    { id: 'cash-b', label: 'Invented second', date: '2026-10-15', amount: 40.07, confidence: 'estimated', sinkingFund: true },
    { id: 'cash-c', label: 'Invented last', date: '2026-10-20', amount: 90.22, confidence: 'confirmed', sinkingFund: true },
  ];
  i.plan.bills = [{ id: 'annual-x', label: 'Invented annual card cost', frequency: 'yearly', month: 10,
    day: 11, firstDue: '2026-10-11', amount: 30.21, confidence: 'confirmed', jointCash: false }];
  i.plan.savingsEarmarks.pools.forEach(pool => { pool.goalRefs = []; });
  for (const [id, value] of [['savings', 72.43], ['savings-dont-touch', 128.55]]) {
    i.plan.savingsPoolObservation.accounts.find(row => row.accountId === id).value = value;
    i.plan.startingCash.breakdown.concat(i.plan.startingCash.heldElsewhere).find(row => row.id === id).value = value;
  }
  return i;
}
const early = [['2026-10-07',8000,20098,28098],['2026-10-09',8000,18885,26885],
  ['2026-10-11',8000,15864,23864],['2026-10-15',8000,11857,19857],
  ['2026-10-20',8000,2835,10835],['2026-11-02',15700,2835,18535]];
const late = [['2026-10-07',8000,20098,28098],['2026-10-23',8000,18885,26885],
  ['2026-10-25',8000,15864,23864],['2026-10-29',8000,11857,19857],
  ['2026-11-02',15700,11857,27557],['2026-11-03',15700,2835,18535]];
for (const afterPayday of [false, true]) for (const destination of [null, 'savings', 'savings-dont-touch'])
  test((afterPayday ? 'post' : 'pre') + '-payday conservation, deposit ' + (destination || 'none'), () => {
    const input = payments();
    if (afterPayday) {
      input.plan.commitments[0].date = '2026-10-23';
      input.plan.bills[0].day = 25; input.plan.bills[0].firstDue = '2026-10-25';
      input.plan.commitments[1].date = '2026-10-29'; input.plan.commitments[2].date = '2026-11-03';
    }
    const offset = destination ? 1111 : 0;
    if (destination) transfer(input, 11.11, destination === 'savings' ? 'AA201' : 'AA202', destination, '2026-10-06');
    const before = JSON.stringify(input);
    const packet = F.recommend(input.plan, input.asOf, { ...input.opts, weeklyVariable: 0, debts: [] }).savingsFunding;
    assert.equal(JSON.stringify(input), before);
    assert.equal(packet.timeline.status, 'ready', packet.timeline.reason);
    const base = afterPayday ? late : early;
    const actual = base.map(([date]) => {
      const row = packet.timeline.daily.find(row => row.date === date); assert.ok(row);
      return [date, ...[row.operatingCash,row.savingsCash,row.combinedHouseholdCash].map(n => Math.round(n * 100))];
    });
    assert.deepEqual(actual, base.map(([d,a,b,t]) => [d,a-offset,b+offset,t]));
    assert.equal(packet.timeline.payments.length, 4);
    assert.equal(packet.timeline.payments.filter(row => row.id === 'annual-x').length, 1);
    assert.equal(packet.backing.actualTransferred, null); assert.equal(packet.period.actualSaved, null);
    assert.equal(packet.schedule.currentPayments.length, afterPayday ? 0 : 3);
  });
for (const unknown of ['price', 'pending']) test('pre-payday ' + unknown + ' remains unknown', () => {
  const input = clone(payments());
  if (unknown === 'price') delete input.plan.bills[0].amount;
  else input.plan.savingsPoolObservation.accounts[0].pendingState = 'pending';
  const packet = F.recommend(input.plan, input.asOf, { ...input.opts, weeklyVariable: 0, debts: [] }).savingsFunding;
  assert.equal(packet.timeline.status, 'unavailable'); assert.deepEqual(packet.timeline.daily, []);
  assert.equal(packet.period.actualSaved, null);
});
// Independent annual-waiver allocation: $119 stock, $61 yearly card bill
// firstDue 2026-10-25 waived, next payable 2027-10-25, later $88 on 2027-11-01.
// Hand-listed due-date-first: 6100 then min(5800, 8800) = 5800, leftover 0.
function annualWaiver(later) {
  const input = fx.ledger();
  input.plan.commitments = later ? [{ id: 'later', label: 'Invented later cost', date: '2027-11-01',
    amount: 88, confidence: 'confirmed', sinkingFund: true }] : [];
  input.plan.bills = [{ id: 'annual', label: 'Invented annual card bill', frequency: 'yearly',
    month: 10, day: 25, firstDue: '2026-10-25', amount: 61, confidence: 'confirmed',
    jointCash: false, noPaymentRequiredOn: ['2026-10-25'] }];
  return input;
}
test('waived first annual occurrence yields next-year backing before a later cost', () => {
  const input = annualWaiver(true), before = JSON.stringify(input);
  const native = F.expandEvents(input.plan, input.asOf, '2027-11-01', { weeklyVariable: 0, ...input.opts })
    .filter(row => row.id === 'annual');
  assert.deepEqual(native.map(row => [row.date, row.amount]), [['2027-10-25', -61]]);
  const packet = F.recommend(input.plan, input.asOf, { ...input.opts, weeklyVariable: 0, debts: [] }).savingsFunding;
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(packet.backing.items.map(row => [row.id, row.date, row.needed, row.saved]),
    [['annual', '2027-10-25', 61, 61], ['later', '2027-11-01', 88, 58]]);
  assert.equal(packet.backing.unallocated, 0);
  assert.equal(Math.round((61 + 58 + 0) * 100), 11900);
});
test('horizon extension reaches the next payable annual when no later cost forces it', () => {
  const input = annualWaiver(false);
  const defaultEnd = F.addDays(input.asOf, 364);
  assert.equal(defaultEnd, '2027-10-06');
  assert.ok(defaultEnd < '2027-10-25');
  const packet = F.recommend(input.plan, input.asOf, { ...input.opts, weeklyVariable: 0, debts: [] }).savingsFunding;
  assert.deepEqual(packet.backing.items.map(row => [row.id, row.date, row.needed, row.saved]),
    [['annual', '2027-10-25', 61, 61]]);
  assert.equal(packet.backing.unallocated, 58);
  const native = F.expandEvents(input.plan, input.asOf, '2027-10-25', { weeklyVariable: 0, ...input.opts })
    .filter(row => row.id === 'annual');
  assert.deepEqual(native.map(row => [row.date, row.amount]), [['2027-10-25', -61]]);
});
test('first payable annual occurrence remains the selected backing date', () => {
  const input = annualWaiver(true);
  delete input.plan.bills[0].noPaymentRequiredOn;
  const packet = F.recommend(input.plan, input.asOf, { ...input.opts, weeklyVariable: 0, debts: [] }).savingsFunding;
  assert.deepEqual(packet.backing.items.map(row => [row.id, row.date, row.needed, row.saved]),
    [['annual', '2026-10-25', 61, 61], ['later', '2027-11-01', 88, 58]]);
  assert.equal(packet.backing.unallocated, 0);
});
test('waived first annual with unknown next amount stays unresolved', () => {
  const input = annualWaiver(true);
  delete input.plan.bills[0].amount;
  const packet = F.recommend(input.plan, input.asOf, { ...input.opts, weeklyVariable: 0, debts: [] }).savingsFunding;
  const unknown = packet.unresolved.find(row => row.id === 'annual');
  assert.ok(unknown);
  assert.equal(unknown.date, '2027-10-25');
  assert.equal(unknown.needed, null);
  assert.equal(unknown.saved, null);
  assert.equal(packet.backing.status, 'unavailable');
  assert.equal(packet.backing.items.find(row => row.id === 'later').saved, null);
});

for (const later of [true, false]) test('two waived annual occurrences retain the next payable cost' + (later ? ' before later cost' : ' without later cost'), () => {
  const input = annualWaiver(later);
  input.plan.bills[0].noPaymentRequiredOn.push('2027-10-25');
  if (later) input.plan.commitments[0].date = '2028-11-01';
  const unchanged = JSON.stringify(input);
  const native = F.expandEvents(input.plan, input.asOf, '2028-10-25', { ...input.opts, weeklyVariable: 0 })
    .filter(row => row.id === 'annual');
  assert.deepEqual(native.map(row => [row.date, row.amount]), [['2028-10-25', -61]]);
  const packet = F.recommend(input.plan, input.asOf, { ...input.opts, weeklyVariable: 0, debts: [] }).savingsFunding;
  assert.equal(JSON.stringify(input), unchanged);
  assert.equal(packet.backing.status, 'ready');
  const expected = [['annual', '2028-10-25', 61, 61]];
  if (later) expected.push(['later', '2028-11-01', 88, 58]);
  assert.deepEqual(packet.backing.items.map(row => [row.id, row.date, row.needed, row.saved]), expected);
  assert.equal(packet.backing.unallocated, later ? 0 : 58);
  assert.equal(packet.backing.items.reduce((sum, row) => sum + Math.round(row.saved * 100), 0)
    + Math.round(packet.backing.unallocated * 100), 11900);
});

for (const value of [null, '']) for (const waived of [false, true]) test('annual ' + JSON.stringify(value) + ' amount stays unknown' + (waived ? ' after a waiver' : ' on first payable'), () => {
  const input = annualWaiver(true);
  if (!waived) input.plan.bills[0].noPaymentRequiredOn = [];
  input.plan.bills[0].amount = value;
  const before = JSON.stringify(input);
  const packet = F.recommend(input.plan, input.asOf, { ...input.opts, weeklyVariable: 0, debts: [] }).savingsFunding;
  assert.equal(JSON.stringify(input), before);
  assert.equal(packet.stock.amount, 119);
  assert.equal(packet.backing.status, 'unavailable');
  const unknown = packet.unresolved.find(row => row.id === 'annual');
  assert.ok(unknown);
  assert.equal(unknown.date, waived ? '2027-10-25' : '2026-10-25');
  assert.equal(unknown.needed, null);
  assert.equal(unknown.saved, null);
  assert.equal(packet.backing.items.find(row => row.id === 'later').saved, null);
  assert.equal(packet.period.actualSaved, null);
  assert.equal(packet.moneyMovementPermission, 'not-granted');
});
