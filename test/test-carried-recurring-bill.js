'use strict';
// A scheduled bill belongs to the pay period containing its due date. Exercise
// the real observer, live overlay, Forecast and Talk packet on invented data.
// Oct 9 - Oct 22 contains the 90 hydro bill. Oct 1 water (120) belongs
// to Sep 25 - Oct 8. Income 1,400 less hydro and the 400 budget leaves 910.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');
const Live = require('../scripts/live-plan.js');
const Assistant = require('../scripts/assistant-packet.js');

const WATER = { id: 'water', label: 'Invented water', amount: 120, frequency: 'monthly', day: 1,
  confidence: 'confirmed', payee: 'Invented water co' };
const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12,
  confidence: 'confirmed', payee: 'Invented hydro' };
const waterDebit = (date, extra) => Object.assign({ date, amount: 120, payee: 'Invented water co', account: 'chequing-a',
  category: 'Utilities' }, extra);
const PAYROLL = { date: '2026-10-09', amount: -1400, payee: 'Invented employer', account: 'chequing-a', category: 'Payroll' };

function world(patch) {
  const w = H.baseWorld();
  w.bills = [Object.assign({}, WATER), Object.assign({}, HYDRO)];
  w.transactions = [H.lm(PAYROLL)];
  w.shape = 'advancing';
  w.datedOpening = '2026-09-20';
  w.ownerRepresented = [];
  // This suite dates the opening itself (before the closed period), so the
  // harness's own payday opening is not applied on top.
  w.productionOpened = true;
  if (patch) patch(w);
  // Unconfigured Savings is observed as household cash, as in the harness's
  // own production opening.
  const savings = w.accounts.find(a => a.id === 'savings' && !a.held);
  if (savings && !w.savingsPool) { savings.reserve = false; savings.role = 'household-cash'; }
  if (w.shape === 'advancing') {
    w.canonicalAsOf = w.datedOpening;
    w.planPatch = p => {
      p.opening = { asOf: w.datedOpening, representedEvents: w.ownerRepresented.slice() };
      for (const row of p.startingCash.breakdown) row.evidenceDate = w.datedOpening;
      if (w.planExtra) w.planExtra(p);
    };
  } else {
    w.planPatch = p => {
      p.opening = { asOf: w.asOf, priorAsOf: w.datedOpening, representedEvents: w.ownerRepresented.slice() };
      if (w.planExtra) w.planExtra(p);
    };
  }
  return w;
}

function read(w, built) {
  const { data, packet, error } = built || H.dataOf(w);
  assert.equal(error, null, 'the observation is applied');
  const plan = data.plan;
  assert.equal(plan.opening.priorAsOf, w.datedOpening, 'priorAsOf is the dated opening');
  const asOf = plan.opening.asOf;
  const opts = { debts: data.debts, currentPeriodActuals: packet };
  const advice = F.recommend(plan, asOf, opts);
  const current = advice.payPeriodViews.find(r => r.start <= asOf && r.end >= asOf);
  const walk = F.expandEvents(plan, asOf, current.end, { debts: data.debts }).filter(e => e && e.kind === 'bill');
  const action = (advice.currentPeriodAction && advice.currentPeriodAction.bills) || [];
  const assistant = Assistant.buildPacket({ data, periods: null, questionsMarkdown: '' });
  const assistantBills = assistant.forecast && assistant.forecast.currentPeriodAction
    ? assistant.forecast.currentPeriodAction.bills : assistant.currentPeriodAction.bills;
  const observed = ((packet && packet.representedActuals) || []).filter(a => a && a.id === 'water');
  return { plan, asOf, advice, current, walk, action, assistantBills, observed, packet,
    represented: plan.opening.representedEvents.filter(e => e.id === 'water').map(e => e.date) };
}
const run = patch => { const w = world(patch); return read(w); };
const rowsFor = (period, id) => (period.bills || []).filter(r => r && r.id === id);
const owed = (list, id, date) => list.filter(b => b.id === id && b.date === date && b.remaining > 0).length;
// Late-payment readers. Other spending is the household budget's own Other
// row for the period; counted() is Forecast's own classification.
const otherSpent = r => {
  const row = (r.current.householdBudget || []).find(x => x && x.otherSpending);
  return row && typeof row.spent === 'number' ? row.spent : 0;
};
const counted = (r, date) => (r.packet.transactions || []).filter(t => t && t.date === date && Number(t.amount) > 0)
  .map(t => F.classifyCurrentPeriodTransaction(t, r.plan, { packet: r.packet, currentPeriodActuals: r.packet }).householdSpending);
// The figures of one period, in the order every late-payment case states
// them: bill load, Other spending, budget hold, Balance After Deductions.
const figures = r => [r.current.periodBillLoad, otherSpent(r), r.current.budgetHold, r.current.balanceAfterDeductions];
const previous = r => r.advice.pastPeriodViews.find(v => v.start === '2026-09-25');
const staysInHistory = r => {
  const own = rowsFor(previous(r), 'water');
  assert.equal(own.length, 1, 'the closed period lists its bill once');
  assert.equal(own[0].date, '2026-10-01');
  assert.notEqual(own[0].status, 'PAID', 'no verified settlement');
  assert.equal(own[0].actual, null);
  assert.equal(own[0].remaining, 120);
  assert.equal(previous(r).periodBillLoad, 120, 'the closed period owns the scheduled expense');
  for (const list of [r.current.bills, r.walk, r.action, r.assistantBills]) {
    assert.ok(!list.some(b => b.id === 'water' && b.date === '2026-10-01'), 'absent from later bills and cash claims');
  }
};

// The timezone probe prints the published dates of the unpaid case and exits.
if (process.argv.includes('--tz-probe')) {
  const r = run();
  console.log('TZ-PROBE ' + JSON.stringify([r.asOf, r.current.start, r.current.end,
    rowsFor(r.current, 'water').map(row => [row.date, row.settlement, row.remaining]),
    r.walk.filter(e => e.id === 'water').map(e => [e.date, e.amount])]));
  process.exit(0);
}

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('  ok ' + name); }

console.log('=== Closed-period recurring bills stay in their own pay period ===');

check('an unverified scheduled bill remains visible only in its own period', () => {
  const r = run();
  assert.equal(r.asOf, '2026-10-14');
  staysInHistory(r);
  assert.equal(r.current.remainingBills, 90);
  assert.equal(r.current.periodBillLoad, 90);
  assert.equal(r.current.balanceAfterDeductions, 910);
  const without = run(w => { w.bills = [Object.assign({}, HYDRO)]; });
  assert.deepEqual(rowsFor(r.current, 'hydro'), rowsFor(without.current, 'hydro'));
  assert.deepEqual(figures(r), figures(without));
  const next = r.advice.payPeriodViews.find(v => v.start === '2026-10-23');
  assert.deepEqual(rowsFor(next, 'water').map(row => row.date), ['2026-11-01']);
});

check('a posted matching debit settles it: not listed, not deducted, Paid in its own period', () => {
  const r = run(w => w.transactions.push(H.lm(waterDebit('2026-10-01'))));
  assert.deepEqual(r.represented, ['2026-10-01'], 'the posted match is named on representedEvents');
  assert.equal(rowsFor(r.current, 'water').length, 0, 'no current-period row');
  assert.equal(r.current.remainingBills, 90);
  assert.equal(r.current.balanceAfterDeductions, 910);
  assert.equal(r.walk.filter(e => e.id === 'water').length, 0, 'no walk deduction');
  assert.ok(r.action.filter(b => b.id === 'water').every(b => b.settlement === 'represented' && b.remaining === 0),
    'Talk owes nothing for it');
  const previous = (r.advice.pastPeriodViews || []).find(v => v.start === '2026-09-25');
  assert.ok(previous, 'positive control: the closed period is published');
  assert.deepEqual(rowsFor(previous, 'water').map(row => [row.date, row.status]), [['2026-10-01', 'PAID']],
    'its own period shows it Paid');
});

check('an owner record of the payment settles it too', () => {
  const r = run(w => { w.ownerRepresented = [{ id: 'water', date: '2026-10-01' }]; });
  assert.equal(rowsFor(r.current, 'water').length, 0);
  assert.equal(r.current.remainingBills, 90);
  assert.equal(r.walk.filter(e => e.id === 'water').length, 0);
});

check('a pending matching debit leaves the prior bill unverified', () => {
  const r = run(w => w.transactions.push(H.lm(waterDebit('2026-10-01', { pending: true }))));
  assert.deepEqual(r.observed.map(a => a.date), ['2026-10-01'], 'the pending match reached the packet');
  assert.deepEqual(r.represented, [], 'pending is never on representedEvents');
  staysInHistory(r);
  assert.equal(r.current.remainingBills, 90);
});

check('a posted debit and a pending copy of it: paid once, nothing carried', () => {
  const r = run(w => w.transactions.push(H.lm(waterDebit('2026-10-01')), H.lm(waterDebit('2026-10-01', { pending: true }))));
  assert.deepEqual(r.represented, ['2026-10-01']);
  assert.equal(rowsFor(r.current, 'water').length, 0);
  assert.equal(r.current.remainingBills, 90);
  assert.equal(r.walk.filter(e => e.id === 'water').length, 0);
});

check('the Budget row, the cash walk and Talk agree in both opening shapes and every evidence state', () => {
  const states = {
    unpaid: () => {},
    posted: w => w.transactions.push(H.lm(waterDebit('2026-10-01'))),
    pending: w => w.transactions.push(H.lm(waterDebit('2026-10-01', { pending: true }))),
    owner: w => { w.ownerRepresented = [{ id: 'water', date: '2026-10-01' }]; },
    // The owner's schedule-trust rule settles the bill on its due date with
    // nothing posted.
    'schedule trust': w => { w.bills[0] = Object.assign({}, WATER, { rule: { settlesWhen: 'schedule-trust-on-due' } }); },
  };
  for (const shape of ['advancing', 'same-day']) {
    for (const [name, patch] of Object.entries(states)) {
      const r = run(w => { w.shape = shape; patch(w); });
      const budget = owed(rowsFor(r.current, 'water'), 'water', '2026-10-01');
      const walk = r.walk.filter(e => e.id === 'water' && e.date === '2026-10-01').length;
      const talk = owed(r.action, 'water', '2026-10-01');
      if (name === 'pending') assert.deepEqual(r.represented, [], `${shape}, pending: never on representedEvents`);
      assert.deepEqual([budget, walk, talk], [0, 0, 0],
        `${shape}, ${name}: list, walk and Talk agree`);
    }
  }
});

check('the list and the cash walk name the same occurrences, once each', () => {
  for (const patch of [null, w => w.transactions.push(H.lm(waterDebit('2026-10-01', { pending: true }))),
    w => { w.bills.push({ id: 'gas', label: 'Invented gas', amount: 70, frequency: 'monthly', day: 5,
      confidence: 'estimated', payee: 'Invented gas co' }); }]) {
    const r = run(patch);
    const listed = (r.current.bills || []).filter(row => row.settlement !== 'represented' && row.date <= r.current.end)
      .map(row => row.id + '@' + row.date).sort();
    const deducted = r.walk.filter(e => e.date <= r.current.end).map(e => e.id + '@' + e.date).sort();
    assert.deepEqual(listed, deducted, 'every bill the walk deducts this period is one listed row');
    assert.equal(new Set(listed).size, listed.length, 'no occurrence is listed twice');
  }
});

check('an estimated bill retains its provenance in its own period', () => {
  const r = run(w => { w.bills[0].confidence = 'estimated'; });
  staysInHistory(r);
  assert.equal(rowsFor(previous(r), 'water')[0].confidence, 'estimated');
});

check('only due dates inside this period are listed', () => {
  const listedDates = day => rowsFor(run(w => { w.bills[0].day = day; w.datedOpening = '2026-09-01'; }).current, 'water')
    .map(row => row.date);
  for (const day of [8, 25, 24]) assert.deepEqual(listedDates(day), []);
  assert.deepEqual(listedDates(9), ['2026-10-09'], 'payday belongs to the new period');
  assert.deepEqual(listedDates(22), ['2026-10-22'], 'its final day is included');
  assert.deepEqual(listedDates(15), ['2026-10-15'], 'the month before is excluded');
});

check('a bill inside the dated opening is neither listed nor deducted', () => {
  // Dated opening Sep 28: Sep 26 is in the closed period but before the
  // dated opening, so it is inside that opening's cash.
  const r = run(w => { w.bills[0].day = 26; w.datedOpening = '2026-09-28'; });
  assert.deepEqual(rowsFor(r.current, 'water').map(row => row.date), [], 'Sep 26 is not carried; Oct 26 is next period');
  assert.equal(r.walk.filter(e => e.id === 'water').length, 0, 'the walk does not deduct it either');
  assert.equal(r.current.remainingBills, 90);
});

check('the date of the opening cannot move a closed-period bill into a later period', () => {
  for (const day of [27, 28, 29]) {
    const r = run(w => { w.bills[0].day = day; w.datedOpening = '2026-09-28'; });
    assert.deepEqual(rowsFor(r.current, 'water'), []);
    assert.ok(!r.walk.some(e => e.id === 'water'));
    assert.equal(r.current.periodBillLoad, 90);
  }
});

check('consecutive periods: the rule moves on with each payday', () => {
  const r = run(w => { w.asOf = '2026-10-23';
    w.transactions.push(H.lm(Object.assign({}, PAYROLL, { date: '2026-10-23' }))); });
  assert.equal(r.asOf, '2026-10-23');
  assert.deepEqual([r.current.start, r.current.end], ['2026-10-23', '2026-11-05']);
  assert.deepEqual(rowsFor(r.current, 'hydro'), []);
  assert.deepEqual(rowsFor(r.current, 'water').map(row => row.date), ['2026-11-01']);
  assert.equal(r.current.periodBillLoad, 120);
  assert.ok(r.walk.every(e => e.date >= r.current.start));
});

check('a biweekly bill unverified in two consecutive periods counts once in each', () => {
  const r = run(w => { w.bills.push({ id: 'lessons', label: 'Invented lessons', amount: 40, frequency: 'biweekly',
    anchor: '2026-09-30', confidence: 'confirmed', payee: 'Invented lessons co' }); });
  assert.deepEqual(rowsFor(previous(r), 'lessons').map(row => row.date), ['2026-09-30']);
  assert.deepEqual(rowsFor(r.current, 'lessons').map(row => row.date), ['2026-10-14']);
  assert.equal(r.walk.filter(e => e.id === 'lessons').length, 1);
  assert.equal(r.current.periodBillLoad, 130, 'hydro 90 + lessons 40');
  // The same inputs read twice give the same answer: nothing is consumed.
  const w = world();
  const built = H.dataOf(w);
  const first = read(w, built), second = read(w, built);
  assert.deepEqual(JSON.stringify(first.current), JSON.stringify(second.current), 'a second read is identical');
});

check('genuine ambiguity: two look-alike bills and one payment leave both to confirm', () => {
  // Two 50 bills to the same payee on Oct 1 and one posted 50 debit. No
  // tie-break: neither settles and both belong to the closed period.
  const r = run(w => {
    w.bills = [{ id: 'water', label: 'Invented water', amount: 50, frequency: 'monthly', day: 1, confidence: 'confirmed',
      payee: 'Invented city utility' }, { id: 'waste', label: 'Invented waste', amount: 50, frequency: 'monthly', day: 1,
      confidence: 'confirmed', payee: 'Invented city utility' }];
    w.transactions.push(H.lm({ date: '2026-10-01', amount: 50, payee: 'Invented city utility', account: 'chequing-a',
      category: 'Utilities' }));
  });
  for (const id of ['water', 'waste']) {
    assert.deepEqual(rowsFor(previous(r), id).map(row => [row.date, row.actual]), [['2026-10-01', null]], id);
    assert.ok(!r.walk.some(e => e.id === id));
  }
  assert.equal(previous(r).periodBillLoad, 100);
  assert.equal(r.current.remainingBills, 0);
});

check('a payment on the boundary day settles the boundary-day bill', () => {
  const r = run(w => { w.bills[0].day = 8; w.transactions.push(H.lm(waterDebit('2026-10-08'))); });
  assert.deepEqual(r.represented, ['2026-10-08']);
  assert.equal(rowsFor(r.current, 'water').length, 0, 'paid on Oct 8: not carried');
  assert.equal(r.walk.filter(e => e.id === 'water').length, 0);
  assert.equal(r.current.remainingBills, 90);
});

check('a late payment counts in the period when the ledger records the spending', () => {
  const late = run(w => w.transactions.push(H.lm(waterDebit('2026-10-10'))));
  assert.deepEqual(counted(late, '2026-10-10'), [true]);
  staysInHistory(late);
  assert.deepEqual(figures(late), [90, 120, 520, 790], '1,400 - 90 hydro - 520 spending');
  const closed = run(w => w.transactions.push(H.lm(waterDebit('2026-10-08'))));
  staysInHistory(closed);
  assert.deepEqual(figures(closed), [90, 0, 400, 910]);
  const recorded = run(w => { w.ownerRepresented = [{ id: 'water', date: '2026-10-01' }];
    w.transactions.push(H.lm(waterDebit('2026-10-10'))); });
  assert.equal(rowsFor(recorded.current, 'water').length, 0, 'recorded: not listed');
  assert.equal(recorded.walk.filter(e => e.id === 'water').length, 0, 'recorded: not deducted by the walk');
  assert.deepEqual(figures(recorded), [90, 120, 520, 790]);
});

check('timezone edge: the period closes on the household calendar day', () => {
  // 22:30 on Oct 8 in Vancouver is already Oct 9 in UTC. Local midnight
  // closes the period and removes the old scheduled claim from current cash.
  const at = (day, fetchedAt) => {
    const w = world(v => { v.asOf = day; v.transactions = [H.lm(Object.assign({}, PAYROLL, { date: '2026-09-25' }))]; });
    const input = { data: H.canonicalOf(w, H.planOf(w)), payload: H.rawPayload(w), accountMap: H.accountMapOf(w),
      identity: H.identityOf(w) };
    input.payload.fetchedAt = fetchedAt;
    const data = Live.fromObservation(input).data;
    return read(w, { data, packet: data.liveOverlay.currentPeriodActuals, error: null });
  };
  const evening = at('2026-10-08', '2026-10-09T05:30:00.000Z');
  assert.equal(evening.asOf, '2026-10-08', 'still Oct 8 for the household');
  assert.deepEqual([evening.current.start, evening.current.end], ['2026-09-25', '2026-10-08']);
  assert.deepEqual(rowsFor(evening.current, 'water').map(row => row.date), ['2026-10-01'], 'listed once, in its own open period');
  assert.equal(evening.walk.filter(e => e.id === 'water' && e.date === '2026-10-01').length, 1);
  const afterMidnight = at('2026-10-09', '2026-10-09T07:30:00.000Z');
  assert.equal(afterMidnight.asOf, '2026-10-09');
  assert.deepEqual([afterMidnight.current.start, afterMidnight.current.end], ['2026-10-09', '2026-10-22']);
  assert.deepEqual(rowsFor(afterMidnight.current, 'water'), []);
  assert.equal(afterMidnight.walk.filter(e => e.id === 'water').length, 0);
});

check('the process timezone moves nothing', () => {
  const expected = JSON.stringify(['2026-10-14', '2026-10-09', '2026-10-22', [], []]);
  for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Vancouver']) {
    const out = execFileSync(process.execPath, [__filename, '--tz-probe'],
      { env: Object.assign({}, process.env, { TZ: zone }), encoding: 'utf8' });
    const line = out.split('\n').find(l => l.startsWith('TZ-PROBE ')) || '';
    assert.equal(line.slice(9), expected, zone);
  }
});

console.log(`${passed} passed`);
