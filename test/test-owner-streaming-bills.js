'use strict';
/* Owner evidence checks are separate from the invented behavior ledger.
 * Each Wise-paid bill owns its one prospective Bills cash requirement.
 * Funding intent is not an actual transfer, purchase or paid occurrence.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');
const root = path.join(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'data.json'), 'utf8'));
const cents = value => Math.round(value * 100);
const clone = value => JSON.parse(JSON.stringify(value));
const specifications = [
  ['paramount-plus', 'Paramount+', 1343, 12, '2026-10-12'],
  ['stacktv', 'STACKTV', 1679, 22, '2026-10-22'],
  ['prime-video-ad-free', 'Prime Video ad-free', 335, 25, '2026-10-25'],
  ['crave-standard-ads', 'Crave Standard with ads', 1343, 9, '2026-11-09'],
];
const ids = new Set(specifications.map(row => row[0]));
const rows = data.plan.bills.filter(row => ids.has(row.id));
assert.equal(rows.length, 4, 'four separate owner-approved bill identities');
assert(data.plan.startingCash.heldElsewhere.some(row => row.id === 'wise'),
  'Wise is an incumbent held-elsewhere identity');
for (const [id, label, amount, day, firstDue] of specifications) {
  const matches = rows.filter(row => row.id === id);
  assert.equal(matches.length, 1, `${id}: no duplicate`);
  const row = matches[0];
  assert.deepEqual([row.label, cents(row.amount), row.frequency, row.day, row.firstDue],
    [label, amount, 'monthly', day, firstDue], `${id}: delegated receipt and forward activation`);
  assert.equal(row.confidence, 'estimated');
  assert.equal(row.dateConfidence, 'estimated');
  assert.equal(row.budgetCategory, 'subscriptions');
  assert.equal(row.subscription, true);
  assert.equal(row.householdObligation, true);
  // Owner fact 2026-11-21 (Dale, via the lead: "all on Bills now"): each is paid from Bills directly, per its
  // Lunch Money recurring item's account; the Wise funding leg is retired.
  assert.equal(row.payingAccount, 'chequing-a');
  assert.equal(Object.hasOwn(row, 'fundingAccount'), false);
  assert.equal(Object.hasOwn(row, 'jointCash'), false);
  assert.equal(F.isCardPaidBill(row, data.plan), false, `${id}: not revolving card debt`);
  assert.equal(F.billAffectsJointCash(row, data.plan), true, `${id}: one planned Bills funding requirement`);
  for (const field of ['settledOn', 'paid', 'paidOn', 'representedEvents', 'merchantKeys', 'noPaymentRequiredOn']) {
    assert.equal(Object.hasOwn(row, field), false, `${id}: no fabricated posting/settlement identity`);
  }
}
assert.equal(rows.reduce((sum, row) => sum + cents(row.amount), 0), 4700,
  'independent receipt cents: 1343 + 1679 + 335 + 1343 = 4700');
const prime = data.plan.bills.filter(row => row.id === 'amazon-prime');
assert.equal(prime.length, 1);
assert.deepEqual([cents(prime[0].amount), prime[0].frequency, prime[0].day, prime[0].firstDue,
  prime[0].payingAccount, prime[0].jointCash, prime[0].confidence],
  [1119, 'monthly', 19, '2026-09-19', 'travelvisa', false, 'confirmed'],
  'Amazon Prime membership remains separate and unchanged');
assert(!F.expandEvents(data.plan, '2026-08-19', '2026-10-10').some(event => ids.has(event.id)),
  'receipt history is not backfilled as scheduled charges or arrears');
assert(!(data.plan.opening.representedEvents || []).some(event => ids.has(event.id)),
  'receipt and funding evidence do not create paid markers');
const identity = JSON.parse(fs.readFileSync(path.join(root, 'docs/connectivity/transaction-identity.json'), 'utf8'));
// Owner-provided recurring ids (2026-11-21): each bill is identified by its own Lunch Money recurring link alone.
const OWNER_ITEMS = { 'paramount-plus': '3722236', stacktv: '3722237', 'prime-video-ad-free': '3722299', 'crave-standard-ads': '3722235' };
for (const id of ids) {
  const rules = identity.rules.filter(rule => rule.eventId === id);
  assert(rules.length === 1 && JSON.stringify(rules[0].lunchMoneyRecurringIds) === JSON.stringify([OWNER_ITEMS[id]])
    && !rules[0].payeePattern && !rules[0].payeePatterns && rules[0].atlasAccountId === 'chequing-a',
    `${id}: one link-only rule naming its owner-provided item, no payee mapping`);
}
console.log('PASS owner receipt/input contract (paid from Bills since 2026-11-21), independent total, separate Prime and no history/paid rewrite');

// Explicit household acceptance is kept apart from invented behavior values.
const forward = F.expandEvents(data.plan, '2026-10-10', '2026-11-30').filter(e => ids.has(e.id));
assert.deepEqual(forward.map(e => [e.id, e.date, -cents(e.amount)]), [
  ['paramount-plus', '2026-10-12', 1343], ['stacktv', '2026-10-22', 1679],
  ['prime-video-ad-free', '2026-10-25', 335], ['crave-standard-ads', '2026-11-09', 1343],
  ['paramount-plus', '2026-11-12', 1343], ['stacktv', '2026-11-22', 1679],
  ['prime-video-ad-free', '2026-11-25', 335],
]);
assert.equal(forward.filter(e => e.date.startsWith('2026-10')).reduce((n,e) => n-cents(e.amount), 0), 3357);
assert.equal(forward.filter(e => e.date.startsWith('2026-11')).reduce((n,e) => n-cents(e.amount), 0), 4700);
assert(forward.every(e => e.jointCash && !e.cardPaid && e.payingAccount === 'chequing-a'
  && !Object.hasOwn(e, 'merchantPayingAccount')));
console.log('PASS separate October forward 3357 cents and November 4700 cents, once per bill');

// Invented values, dates and labels: behavior is not specified by live cents.
const syntheticRows = [
  ['stream-a', 7.11, 5, '2031-04-05'],
  ['stream-b', 9.22, 14, '2031-04-14'],
  ['stream-c', 1.33, 21, '2031-04-21'],
  ['stream-d', 7.11, 3, '2031-05-03'],
].map(([id, amount, day, firstDue]) => ({id, label: id, amount, day, firstDue,
  frequency: 'monthly', confidence: 'estimated', dateConfidence: 'estimated',
  householdObligation: true, payingAccount: 'wise', fundingAccount: 'chequing-a', jointCash: false,
  budgetCategory: 'subscriptions', subscription: true}));
const plan = {
  defaults: { targetBuffer: 0 },
  startingCash: { breakdown: [{id: 'chequing-a', label: 'Synthetic Bills', value: 1000}, { id: 'chequing-b', value: 0 }],
    heldElsewhere: [{id: 'wise', label: 'Synthetic Wise', value: 2}] },
  opening: { asOf: '2031-04-04', representedEvents: [] },
  income: [], obligations: [], commitments: [], bills: syntheticRows,
};
const original = clone(plan);
const expected = [
  ['stream-a', '2031-04-05', -711], ['stream-b', '2031-04-14', -922],
  ['stream-c', '2031-04-21', -133], ['stream-d', '2031-05-03', -711],
  ['stream-a', '2031-05-05', -711], ['stream-b', '2031-05-14', -922],
  ['stream-c', '2031-05-21', -133],
];
const events = F.expandEvents(plan, '2031-04-04', '2031-05-31');
assert.deepEqual(events.map(event => [event.id, event.date, cents(event.amount)]), expected,
  'hand-listed monthly calendar activates each occurrence once');
assert.equal(events.reduce((sum, event) => sum - cents(event.amount), 0), 4243,
  'independent two-month ledger: 1766 + 2477 = 4243 cents');
assert(events.every(event => event.kind === 'bill' && event.householdObligation === true
  && event.jointCash === true && event.cardPaid === false && event.confidence === 'estimated'
  && event.payingAccount === 'chequing-a' && event.merchantPayingAccount === 'wise'
  && /BILLS ACCOUNT.*funding.*Synthetic Wise/.test(event.payerLabel)));
assert.equal(F.expandEvents(plan, '2031-03-01', '2031-04-04').length, 0,
  'no retroactive receipt occurrence');
const opts = { viewDays: 58, horizonDays: 58, weeklyVariable: 0, targetBuffer: 0 };
const sim = F.simulate(plan, '2031-04-04', opts);
assert.equal(cents(sim.ending), 95757, '100000 - 4243 = 95757; Wise balance never joins cash');
assert.equal(cents(sim.totals.bills), 4243);
assert.equal(cents(sim.totals.reserved), 0, 'Wise is not card-paid backfill gravity');
assert.equal(cents(sim.totals.income), 0);
assert.equal(sim.events.length, 7, 'the schedule retains every household obligation');

// Same-day funding is source-only; a small or stale held balance is not proof
// of settlement. Advancing the start does not pretend the new cycle is paid.
const after = clone(plan);
after.opening.asOf = '2031-05-04';
const later = F.expandEvents(after, '2031-05-04', '2031-06-03');
assert.deepEqual(later.map(event => [event.id, event.date, cents(event.amount)]), [
  ['stream-a', '2031-05-05', -711], ['stream-b', '2031-05-14', -922],
  ['stream-c', '2031-05-21', -133], ['stream-d', '2031-06-03', -711],
]);
assert.deepEqual(plan, original, 'consumers do not mutate source or history');

const carried = clone(plan);
carried.opening = {asOf:'2031-04-15', priorAsOf:'2031-04-04', representedEvents:[]};
const carriedSim = F.simulate(carried, '2031-04-15', {...opts, viewDays:16, horizonDays:16});
assert.deepEqual(carriedSim.events.filter(e => e.date < '2031-04-15').map(e => [e.id,e.date]),
  [['stream-a','2031-04-05'],['stream-b','2031-04-14']], 'unresolved funding survives opening advance');
assert.equal(cents(carriedSim.totals.bills), 1766, '711 + 922 carried and 133 upcoming deducted once');
assert.equal(cents(carriedSim.ending), 98234);
carried.opening.representedEvents.push({id:'stream-a', date:'2031-04-05'});
assert.equal(cents(F.simulate(carried, '2031-04-15', {...opts,viewDays:16,horizonDays:16}).totals.bills), 1055,
  'only the exact represented occurrence resolves; 922 + 133 remain');

const legacyHeld = clone(plan);
legacyHeld.bills.forEach(row => { delete row.fundingAccount; });
const legacySim = F.simulate(legacyHeld, '2031-04-04', opts);
assert.equal(cents(legacySim.ending), 100000, 'absent funding field preserves held-elsewhere semantics');
assert.equal(cents(legacySim.totals.bills), 0);
assert.equal(cents(legacySim.totals.reserved), 0);
assert(legacySim.events.every(e => e.payingAccount === 'wise' && e.jointCash === false
  && !Object.hasOwn(e,'merchantPayingAccount') && !Object.hasOwn(e,'fundingAccount')));

// A separately card-paid membership still reserves its own cost exactly once.
const withMembership = clone(plan);
withMembership.bills.push({id:'membership', label:'Synthetic membership', amount:4.56,
  frequency:'monthly', day:18, firstDue:'2031-04-18', confidence:'confirmed',
  budgetCategory:'subscriptions', payingAccount:'card-one', jointCash:false});
const membershipSim = F.simulate(withMembership, '2031-04-04', opts);
assert.equal(cents(membershipSim.totals.reserved), 912, 'two distinct membership reserves, 456 + 456');
assert.equal(cents(membershipSim.totals.bills), 4243, 'streaming funding once, no duplicated membership cash purchase');

// Removing held-elsewhere attribution makes explicit jointCash:false a card
// reserve. This control detects incorrectly inventing a revolving payer.
const wrongPayer = clone(legacyHeld);
wrongPayer.bills.forEach(row => { row.payingAccount = 'unknown-instrument'; });
assert(wrongPayer.bills.every(row => F.isCardPaidBill(row, wrongPayer)));
assert.equal(cents(F.simulate(wrongPayer, '2031-04-04', opts).totals.reserved), 4243,
  'negative control: unsupported instrument cannot masquerade as held Wise cash');
for (const change of [
  p => {p.bills[0].fundingAccount = 'wise';},
  p => {p.bills[0].fundingAccount = 'chequing-b';},
  p => {p.bills[0].fundingAccount = null;},
  p => {delete p.bills[0].payingAccount;},
  p => {p.bills[0].payingAccount = 'unknown-instrument';},
  p => {p.bills[0].payingAccount = 'chequing-a';},
  p => {p.bills[0].jointCash = true;},
  p => {p.bills[0].cardPaid = true;},
  p => {p.bills[0].nonCash = true;},
  p => {p.bills[0].householdObligation = false;},
  p => {p.startingCash.breakdown = [];},
  p => {p.startingCash.breakdown.push(clone(p.startingCash.breakdown[0]));},
  p => {p.obligations.push({debtId:'wise'});},
]) {
  const invalid = clone(plan); change(invalid);
  for (const compute of [() => F.expandEvents(invalid,'2031-04-04','2031-05-31'),
    () => F.billAffectsJointCash(invalid.bills[0],invalid), () => F.isCardPaidBill(invalid.bills[0],invalid)]) {
    assert.throws(compute, /Invalid bill fundingAccount contract: stream-a/);
  }
}
console.log('PASS independent per-bill funding/cash, carried opening, absent-field behavior and invalid contracts');

// Independently selected native stock identity, separate from live input cents:
// 82347 + 26319 - (1723 + 711 + 922 + 133) - 941 - 10040 = 94196.
const fx = require('./fixtures/bills-period-end-balance-data');
const x = fx.requirementsFixture();
x.plan.startingCash.heldElsewhere = [{id:'wise',label:'Synthetic Wise',value:2}];
const nativeRows = [
  ['wallet-a',7.11,21,'2026-08-21'], ['wallet-b',9.22,24,'2026-08-24'],
  ['wallet-c',1.33,26,'2026-08-26'], ['wallet-d',7.11,3,'2026-09-03'],
].map(([id,amount,day,firstDue]) => ({id,label:id,amount,day,firstDue,frequency:'monthly',
  confidence:'estimated',dateConfidence:'estimated',householdObligation:true,subscription:true,
  budgetCategory:'subscriptions',payingAccount:'wise',fundingAccount:'chequing-a',jointCash:false}));
x.plan.bills.push(...nativeRows);
const nativeIds = new Set(nativeRows.map(r=>r.id));
const nativeBefore = clone(x);
const periods = {periods:{ytd:{label:'Invented month',months:1,spending:[{label:'Subscriptions',total:87.65}]}}};
const nativeOpts = {...x.opts,weeklyVariable:0,periods};
const closing = F.billsAccountPeriodBalance(x.plan,x.asOf,nativeOpts);
assert.equal(closing.status,'ready','ordinary future bills reserve normally, without global unknown withholding');
assert.equal(cents(closing.amount),94196);
assert.equal(cents(closing.remainingBills),3489, '1723 + 711 + 922 + 133, each once');
assert.equal(cents(closing.additionalCardCash),0);
assert.equal(cents(closing.futureIncome),26319);
assert.equal(cents(closing.household.target),10040,'no subscription category smear');
assert(/individual planned funding/.test(closing.accountAssumption));
const action = F.currentPeriodAction(x.plan,x.asOf,nativeOpts);
const publication = F.recommend(x.plan,x.asOf,nativeOpts).defaultView;
const allocation = F.paydayAllocation(x.plan,x.asOf,nativeOpts);
const amounts = rows => rows.filter(r=>nativeIds.has(r.id)).map(r=>[r.id,r.date,cents(r.remaining ?? r.amount)]);
const nativeExpected = [['wallet-a','2026-08-21',711],['wallet-b','2026-08-24',922],['wallet-c','2026-08-26',133]];
assert.deepEqual(amounts(action.bills),nativeExpected,'current-period bills');
assert.deepEqual(amounts(publication.bills).filter(r=>r[1] <= '2026-08-27'),nativeExpected,'calendar publication');
assert.deepEqual(amounts(allocation.obligations.items),nativeExpected,'payday requirements');
assert.deepEqual(publication.billsAccountPeriodBalance,closing,'published Bills closing follows the same source');
for (const rows of [action.bills,publication.bills,allocation.obligations.items,action.thisPaydayDue]) {
  for (const row of rows.filter(r=>nativeIds.has(r.id))) {
    assert.equal(row.payingAccount,'chequing-a');
    assert.equal(row.fundingAccount,'chequing-a');
    assert.equal(row.merchantPayingAccount,'wise');
    assert(/BILLS ACCOUNT.*funding.*Synthetic Wise/.test(row.payerLabel),'source and merchant route stay explicit');
  }
}
const trajectory = F.baselineTrajectory(x.plan,x.opts.debts,x.asOf,nativeOpts);
const active = trajectory.payPeriods[0], next = trajectory.payPeriods[1];
assert.equal(cents(active.stage1.bills.amount),3489);
assert.equal(cents(active.stage1.result.amount),22830,'26319 income - 3489 bill funding, no category smear');
assert.equal(cents(active.stage2.result.amount),21889,'22830 - 941 dated commitment');
assert.equal(cents(next.stage1.bills.amount),711,'next cycle owns wallet-d once');
assert.equal(cents(next.stage1.result.amount),107026,'107737 - 711');
assert.deepEqual(active.stage1.bills.lines.filter(r=>nativeIds.has(r.id)).map(r=>[r.id,cents(r.amount)]),
  [['wallet-a',711],['wallet-b',922],['wallet-c',133]]);
assert.deepEqual(x,nativeBefore,'current/future cash consumers preserve canonical source and actual history');

// A backfill debit with a coincident amount has no bill-occurrence identity.
// Native transfer reconciliation remains responsible for actual cash; the
// amount alone cannot mark any future wallet merchant charge paid.
const actualBackfill = clone(x);
actualBackfill.opts.currentPeriodActuals.transactions.push(fx.tx('wallet-backfill','chequing-a',x.asOf,24.77,'Payment, Transfer'));
const withBackfill = F.currentPeriodAction(actualBackfill.plan,x.asOf,{...nativeOpts,
  currentPeriodActuals:actualBackfill.opts.currentPeriodActuals});
assert.deepEqual(amounts(withBackfill.bills),nativeExpected);
assert(withBackfill.bills.filter(r=>nativeIds.has(r.id)).every(r=>r.settlement==='upcoming' && r.actual===0));
console.log('PASS Bills closing/current calendar/payday/future trajectory attribution and amount-only backfill exclusion');
