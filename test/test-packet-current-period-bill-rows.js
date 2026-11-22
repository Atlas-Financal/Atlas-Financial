'use strict';
// The assistant packet's current-period bill rows are the rows of the pay
// period the packet names, selected first and capped second.
// `node test/test-packet-current-period-bill-rows.js`
//
// The cash lookback may reach earlier periods, but an unverified bill or
// minimum now stays in its scheduled period. The packet still selects from
// its action list before capping: in-period rows plus any earlier occurrence
// the selected period view explicitly lists. billsTotal and billsTruncated
// describe the selected rows, not the unscreened list.
//
// Failure it detects: older lookback rows crowding out the named period's
// rows; a carried earlier row the page lists going missing from Talk; an
// earlier row the page does not list on this period reaching Talk; a count or
// truncated flag describing the unselected list. Release decision: any
// failure blocks.
//
// Invented household from test/acceptance/harness.js, through the real
// observer, live overlay, Forecast and assistant packet. Current pay period
// Oct 9 - Oct 22 (as of Oct 14); previous Sep 25 - Oct 8. The dated opening is
// Jun 1, so the lookback spans four months. Every expectation is written by
// hand. No household figure enters.
const assert = require('node:assert/strict');
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');
const Assistant = require('../scripts/assistant-packet.js');

const OPENING = '2026-06-01';
const PAYROLL = { date: '2026-10-09', amount: -1400, payee: 'Invented employer', account: 'chequing-a', category: 'Payroll' };

// Ten invented monthly bills, b0..b9, due on days 1, 3, ..., 19.
const tenBills = () => Array.from({ length: 10 }, (_, i) => ({ id: 'b' + i, label: 'Invented bill ' + i,
  amount: 10 + i, frequency: 'monthly', day: 1 + i * 2, confidence: 'confirmed', payee: 'Invented payee ' + i }));

function world(patch) {
  const w = H.baseWorld();
  w.bills = tenBills();
  w.commitments = [];
  w.obligations = [];
  w.transactions = [H.lm(PAYROLL)];
  // This suite dates the opening itself, so the harness's own payday opening
  // is not applied on top.
  w.productionOpened = true;
  const savings = w.accounts.find(a => a.id === 'savings' && !a.held);
  if (savings) { savings.reserve = false; savings.role = 'household-cash'; }
  w.canonicalAsOf = OPENING;
  w.planPatch = p => {
    p.opening = { asOf: OPENING, representedEvents: [] };
    for (const row of p.startingCash.breakdown) row.evidenceDate = OPENING;
  };
  if (patch) patch(w);
  return w;
}

function run(patch, packetAdviceFixture) {
  const { data, packet, error } = H.dataOf(world(patch));
  assert.equal(error, null, 'the observation is applied');
  const plan = data.plan;
  assert.equal(plan.opening.asOf, '2026-10-14', 'the live overlay advanced the opening');
  assert.equal(plan.opening.priorAsOf, OPENING, 'the lookback reaches back to the dated opening');
  const advice = F.recommend(plan, plan.opening.asOf, { debts: data.debts, currentPeriodActuals: packet });
  const action = advice.currentPeriodAction;
  const view = advice.payPeriodViews.find(v => v && v.timelineRole === 'current');
  let built;
  const recommend = F.recommend;
  try {
    if (packetAdviceFixture) F.recommend = (...args) => packetAdviceFixture(recommend(...args));
    built = Assistant.buildPacket({ data, periods: null, questionsMarkdown: '' });
  } finally { F.recommend = recommend; }
  const talk = (built.forecast || built).currentPeriodAction;
  return { action, view, talk };
}

const key = row => row.id + '@' + row.date;

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('  ok ' + name); }

console.log('=== packet current-period bill rows: select the named period, then cap ===');

const CURRENT = [
  'b4@2026-10-09', 'b5@2026-10-11', 'b6@2026-10-13',
  'b7@2026-10-15', 'b8@2026-10-17', 'b9@2026-10-19',
];
check('the real Forecast keeps prior unverified bills out of this period despite the long lookback', () => {
  const r = run();
  assert.equal(r.action.periodStart, '2026-10-09');
  assert.equal(r.action.periodEnd, '2026-10-22');
  assert.deepEqual(r.action.bills.map(key), CURRENT);
  assert.deepEqual(r.talk.bills.map(key), CURRENT);
  assert.equal(r.talk.billsTotal, CURRENT.length);
  assert.equal(r.talk.billsTruncated, false);
  assert.deepEqual(r.talk.bills.map(b => b.settlement),
    ['unverified', 'unverified', 'unverified', 'upcoming', 'upcoming', 'upcoming']);
});

check('the packet filters a synthetic over-cap history before the cap', () => {
  let injected = 0;
  const r = run(undefined, advice => {
    const action = advice.currentPeriodAction;
    const old = Array.from({ length: Assistant.CURRENT_PERIOD_BILLS_MAX + 2 }, (_, i) =>
      ({ ...action.bills[0], id: 'old-' + i, date: '2026-09-30' }));
    injected += old.length;
    return { ...advice, currentPeriodAction: { ...action, bills: old.concat(action.bills) } };
  });
  assert.ok(injected > Assistant.CURRENT_PERIOD_BILLS_MAX, 'the cap-before-filter control actually ran');
  assert.deepEqual(r.talk.bills.map(key), CURRENT);
  assert.equal(r.talk.billsTotal, CURRENT.length);
  assert.equal(r.talk.billsTruncated, false);
});

check('Talk lists exactly the page\'s current pay-period bill rows', () => {
  const r = run();
  assert.equal(r.view.start, r.action.periodStart, 'the view is the named period');
  assert.deepEqual(r.talk.bills.map(key), r.view.bills.map(key), 'same occurrences, same order');
});

check('commitments and obligations: in-period rows stay, earlier rows the page does not list leave', () => {
  const r = run(w => {
    w.commitments = [
      { id: 'c-old', label: 'Invented old purchase', date: '2026-09-28', amount: 45, confidence: 'confirmed' },
      { id: 'c-early', label: 'Invented early purchase', date: '2026-10-03', amount: 50, confidence: 'confirmed' },
      { id: 'c-in', label: 'Invented in-period purchase', date: '2026-10-16', amount: 40, confidence: 'confirmed' },
    ];
    w.obligations = [
      { id: 'ob', label: 'Invented loan payment', amount: 75, frequency: 'monthly', day: 5, effect: 'payment', confidence: 'confirmed' },
      { id: 'ob2', label: 'Invented loan two', amount: 65, frequency: 'monthly', day: 12, effect: 'payment', confidence: 'confirmed' },
    ];
  });
  // Earlier commitments can remain in the cash lookback action list.
  // The earlier scheduled loan payment no longer rolls into it.
  const owed = r.action.bills.map(key);
  for (const k of ['c-old@2026-09-28', 'c-early@2026-10-03']) assert.ok(owed.includes(k), k + ' is on Forecast\'s list');
  assert.ok(!owed.includes('ob@2026-10-05'), 'the old obligation does not roll into the action list');
  // The page and Talk both exclude those earlier rows.
  const viewed = r.view.bills.map(key);
  for (const k of ['c-old@2026-09-28', 'c-early@2026-10-03', 'ob@2026-10-05']) {
    assert.ok(!viewed.includes(k), k + ' is not on the page\'s current period');
    assert.ok(!r.talk.bills.map(key).includes(k), k + ' is not on Talk\'s current period');
  }
  // In-period rows of every kind stay, including a commitment the view does
  // not list among its bill rows.
  assert.ok(!viewed.includes('c-in@2026-10-16'), 'the view lists no commitment rows');
  assert.deepEqual(r.talk.bills.map(key), [
    'b4@2026-10-09', 'b5@2026-10-11', 'ob2@2026-10-12', 'b6@2026-10-13', 'b7@2026-10-15', 'c-in@2026-10-16',
    'b8@2026-10-17', 'b9@2026-10-19',
  ]);
  assert.equal(r.talk.billsTotal, 8);
  assert.equal(r.talk.billsTruncated, false);
});

check('the cap applies to the named period, and the flag says so', () => {
  // 34 more invented bills, all due Oct 15, on top of the ten.
  const extra = Array.from({ length: 34 }, (_, i) => ({ id: 'x' + i, label: 'Invented extra ' + i, amount: 5,
    frequency: 'monthly', day: 15, confidence: 'confirmed', payee: 'Invented extra payee ' + i }));
  const r = run(w => { w.bills = tenBills().concat(extra); });
  assert.equal(r.talk.billsTotal, 40, '6 + 34 rows belong to the named period');
  assert.equal(r.talk.bills.length, Assistant.CURRENT_PERIOD_BILLS_MAX, 'capped at the maximum');
  assert.equal(r.talk.billsTruncated, true, 'the carried list is not the whole period');
  const viewed = new Set(r.view.bills.map(key));
  assert.ok(r.talk.bills.every(b => b.date >= '2026-10-09' || viewed.has(key(b))),
    'every carried row is the named period\'s: no older history');
});

console.log(`packet current-period bill rows: ${passed} checks passed`);
