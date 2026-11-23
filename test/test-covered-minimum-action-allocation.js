'use strict';
/* Hunt 2 H2-9: a card minimum the card ledger already covered with a posted
 * payment (Forecast.reconcileCardPurchases minimumCoverage, A4) was PAID on the
 * Bills row but still wanted by paydayAllocation and still "pay today" in
 * currentPeriodAction. Both now read the one covered-minimum owner
 * (withCoveredCardMinimums / coveredCardMinimum) the walk, the debt projection
 * and the Bills rows already read.
 *
 * Invented world (test/fixtures/card-coverage-aggregate-world.js): Bills 500,
 * card 400, groceries allowance 150, a 25 card minimum due on the as-of
 * 2026-09-20, one 80 grocery purchase on the card. Every expected figure is
 * written by hand.
 *
 * `node test/test-covered-minimum-action-allocation.js`
 */
const cp = require('node:child_process');
const vm = require('node:vm');
const F = require('../public/forecast');
const A = require('../scripts/assistant-packet');
const Live = require('../scripts/live-plan');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

// The previous engine (main before this change) is the regression reference for the
// uncovered case only, never the source of an expected value.
const BASE = 'd5d11c22e5d891d7112df73c6f5cd27a74ad46fb';
const prior = { module: { exports: {} }, console };
vm.runInNewContext(cp.execFileSync('git', ['show', BASE + ':public/forecast.js'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }), prior);
const OLD = prior.module.exports;

let checks = 0, failures = 0;
const ok = (cond, label, detail) => { checks++; if (cond) console.log('  PASS  ' + label); else { failures++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); } };
const purchase = ['card', 80, null, 'purchase'];
const pay = amount => [['bills', amount, null, 'cash'], ['card', -amount, null, 'credit']];
const cents = x => Math.round(Number(x) * 100);
const travelAction = s => (s.advice.currentPeriodAction.bills || []).filter(b => b.id === 'travel');
const travelWanted = s => (s.advice.paydayAllocation.obligations.items || [])
  .filter(i => i.id === 'travel').reduce((sum, i) => sum + cents(i.amount), 0);
const payToday = s => (s.advice.currentPeriodAction.todayActions || []).filter(a => a.kind === 'pay' && a.id === 'travel');

console.log('1. Covered in full (25 of the 105 payment): every reader agrees it is paid');
{
  const s = run(world([purchase, ...pay(105)]));
  const row = s.period.bills.find(b => b.id === 'travel');
  ok(s.coverage.minimumCoverage[0].status === 'covered-by-payment' && row.status === 'PAID' && row.remaining === 0,
    'the card ledger and the Bills row: covered, PAID, 0 remaining (unchanged)');
  ok(travelWanted(s) === 0 && cents(s.advice.paydayAllocation.obligations.wanted) === 0,
    'paydayAllocation no longer wants the covered 25');
  const action = travelAction(s);
  ok(action.length === 1 && action[0].remaining === 0 && action[0].settlement === 'represented'
    && cents(action[0].actual) === 2500 && action[0].minimumCoverage && action[0].minimumCoverage.status === 'covered-by-payment',
    'currentPeriodAction: represented, 0 remaining, 25.00 covered, with the ledger evidence');
  ok(payToday(s).length === 0, 'no "pay 25 today" action');
  ok(s.advice.currentPeriodAction.moneyMovementRequired === false, 'no money movement is required');
  ok(cents(s.advice.defaultView.afterBills) === cents(s.advice.paydayAllocation.runningLeftover.currentBalance),
    'the running leftover after bills equals the balance: nothing left to pay');
}

console.log('2. Covered in part (20 of 25): only the 5.00 remainder is still due, everywhere');
{
  const s = run(world([purchase, ...pay(20)]));
  const row = s.period.bills.find(b => b.id === 'travel');
  ok(row.remaining === 5, 'the Bills row: 25 - 20 = 5.00 still due (unchanged)');
  ok(travelWanted(s) === 500, 'paydayAllocation wants 5.00');
  const action = travelAction(s);
  ok(action.length === 1 && cents(action[0].remaining) === 500 && cents(action[0].actual) === 2000,
    'currentPeriodAction: 5.00 remaining, 20.00 covered');
  const today = payToday(s);
  ok(today.length === 1 && cents(today[0].amount) === 500, 'today asks to pay 5.00, not 25.00',
    JSON.stringify(today.map(a => a.amount)));
}

console.log('3. Not covered: unchanged from the previous engine');
{
  const x = world([purchase]);
  const observed = Live.fromObservation(x);
  const opts = { debts: observed.data.debts, currentPeriodActuals: observed.data.liveOverlay.currentPeriodActuals };
  const now = F.recommend(observed.data.plan, x.asOf, opts), was = OLD.recommend(observed.data.plan, x.asOf, opts);
  ok(JSON.stringify(now.paydayAllocation) === JSON.stringify(was.paydayAllocation), 'paydayAllocation equals the previous engine');
  ok(JSON.stringify(now.currentPeriodAction) === JSON.stringify(was.currentPeriodAction), 'currentPeriodAction equals the previous engine');
  const s = run(world([purchase]));
  ok(travelWanted(s) === 2500 && payToday(s).length === 1 && cents(payToday(s)[0].amount) === 2500,
    'the uncovered 25.00 is still wanted and still paid today');
}

console.log('4. The assistant packet (MCP) carries the same answer');
{
  const packet = rows => A.buildPacket({ data: Live.fromObservation(world(rows)).data, periods: null, questionsMarkdown: '' });
  const full = packet([purchase, ...pay(105)]);
  const bill = (full.forecast.currentPeriodAction.bills || []).find(b => b.id === 'travel');
  ok(bill && bill.remaining === 0, 'packet: the covered minimum shows 0 remaining', JSON.stringify(bill && bill.remaining));
  ok(!(full.forecast.currentPeriodAction.todayActions || []).some(a => a.id === 'travel'), 'packet: no pay-today action for it');
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
