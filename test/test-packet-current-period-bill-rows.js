'use strict';
// The assistant packet's current-period bill rows are the rows of the pay
// period the packet names, selected first and capped second.
// `node test/test-packet-current-period-bill-rows.js`
//
// Forecast's currentPeriodAction.bills is expanded from the cash lookback
// origin (plan.opening.priorAsOf), which can reach back across several pay
// periods. The packet capped that list at CURRENT_PERIOD_BILLS_MAX before any
// selection, so a long lookback filled every carried row with older history
// and the named period's own bills never reached Talk. The packet now keeps a
// row dated inside periodStart..periodEnd (any kind), plus an earlier row only
// when Forecast's current pay-period view itself lists that occurrence
// (id@date) on this period, then caps. billsTotal and billsTruncated describe
// that selection.
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

function run(patch) {
  const { data, packet, error } = H.dataOf(world(patch));
  assert.equal(error, null, 'the observation is applied');
  const plan = data.plan;
  assert.equal(plan.opening.asOf, '2026-10-14', 'the live overlay advanced the opening');
  assert.equal(plan.opening.priorAsOf, OPENING, 'the lookback reaches back to the dated opening');
  const advice = F.recommend(plan, plan.opening.asOf, { debts: data.debts, currentPeriodActuals: packet });
  const action = advice.currentPeriodAction;
  const view = advice.payPeriodViews.find(v => v && v.timelineRole === 'current');
  const built = Assistant.buildPacket({ data, periods: null, questionsMarkdown: '' });
  const talk = (built.forecast || built).currentPeriodAction;
  return { action, view, talk };
}

const key = row => row.id + '@' + row.date;

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('  ok ' + name); }

console.log('=== packet current-period bill rows: select the named period, then cap ===');

check('a long lookback does not crowd the named period out of Talk', () => {
  const r = run();
  assert.equal(r.action.periodStart, '2026-10-09');
  assert.equal(r.action.periodEnd, '2026-10-22');
  // Positive control: Forecast's own list is long and mostly older history.
  assert.ok(r.action.bills.length > Assistant.CURRENT_PERIOD_BILLS_MAX, 'the lookback list exceeds the cap');
  assert.ok(r.action.bills.filter(b => b.date < '2026-10-09').length > Assistant.CURRENT_PERIOD_BILLS_MAX,
    'more than a cap of rows predate the period');
  // b0..b3 (Oct 1-7) are the previous closed period's unproven recurring
  // bills that the page carries on this period; b4..b9 are due in it.
  assert.deepEqual(r.talk.bills.map(key), [
    'b0@2026-10-01', 'b1@2026-10-03', 'b2@2026-10-05', 'b3@2026-10-07',
    'b4@2026-10-09', 'b5@2026-10-11', 'b6@2026-10-13', 'b7@2026-10-15', 'b8@2026-10-17', 'b9@2026-10-19',
  ]);
  assert.equal(r.talk.billsTotal, 10, 'the count is the named period\'s');
  assert.equal(r.talk.billsTruncated, false, 'nothing of the named period is left out');
  assert.deepEqual(r.talk.bills.map(b => [b.date >= '2026-10-15' ? 'upcoming' : 'unverified', b.settlement]).filter(([a, b]) => a !== b), [],
    'settlement is Forecast\'s own: due rows upcoming, earlier rows to confirm');
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
  // Forecast still lists the earlier commitments and obligation as owed...
  const owed = r.action.bills.map(key);
  for (const k of ['c-old@2026-09-28', 'c-early@2026-10-03', 'ob@2026-10-05']) assert.ok(owed.includes(k), k + ' is on Forecast\'s list');
  // ...but its current pay-period view does not name them on this period
  // (it carries recurring bills only), so neither does Talk. This is the
  // deliberate consequence: a prior-period item does not belong to the
  // current period.
  const viewed = r.view.bills.map(key);
  for (const k of ['c-old@2026-09-28', 'c-early@2026-10-03', 'ob@2026-10-05']) {
    assert.ok(!viewed.includes(k), k + ' is not on the page\'s current period');
    assert.ok(!r.talk.bills.map(key).includes(k), k + ' is not on Talk\'s current period');
  }
  // In-period rows of every kind stay, including a commitment the view does
  // not list among its bill rows.
  assert.ok(!viewed.includes('c-in@2026-10-16'), 'the view lists no commitment rows');
  assert.deepEqual(r.talk.bills.map(key), [
    'b0@2026-10-01', 'b1@2026-10-03', 'b2@2026-10-05', 'b3@2026-10-07',
    'b4@2026-10-09', 'b5@2026-10-11', 'ob2@2026-10-12', 'b6@2026-10-13', 'b7@2026-10-15', 'c-in@2026-10-16',
    'b8@2026-10-17', 'b9@2026-10-19',
  ]);
  assert.equal(r.talk.billsTotal, 12);
  assert.equal(r.talk.billsTruncated, false);
});

check('the cap applies to the named period, and the flag says so', () => {
  // 34 more invented bills, all due Oct 15, on top of the ten.
  const extra = Array.from({ length: 34 }, (_, i) => ({ id: 'x' + i, label: 'Invented extra ' + i, amount: 5,
    frequency: 'monthly', day: 15, confidence: 'confirmed', payee: 'Invented extra payee ' + i }));
  const r = run(w => { w.bills = tenBills().concat(extra); });
  assert.equal(r.talk.billsTotal, 44, '10 + 34 rows belong to the named period');
  assert.equal(r.talk.bills.length, Assistant.CURRENT_PERIOD_BILLS_MAX, 'capped at the maximum');
  assert.equal(r.talk.billsTruncated, true, 'the carried list is not the whole period');
  const viewed = new Set(r.view.bills.map(key));
  assert.ok(r.talk.bills.every(b => b.date >= '2026-10-09' || viewed.has(key(b))),
    'every carried row is the named period\'s: no older history');
});

console.log(`packet current-period bill rows: ${passed} checks passed`);
