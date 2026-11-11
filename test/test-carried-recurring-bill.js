'use strict';
// #953: an unproven RECURRING bill from the immediately preceding closed pay
// period is listed once on the current pay period, "to confirm", exactly
// like an unproven one-off. `node test/test-carried-recurring-bill.js`
//
// The cash walk already deducts every unrepresented joint-cash outflow after
// the dated opening (plan.opening.priorAsOf). On main the Budget bill list
// filed a recurring occurrence only in its own closed period, so the cash
// figure included a bill the current period's list did not name. The list
// now reads the walk's own carry, so the two cannot disagree.
//
// Invented household from test/acceptance/harness.js, through the real
// observer, live overlay, Forecast and assistant packet. Two opening shapes:
//   advancing - the plan is dated Sep 20 and the observation is Oct 14, so
//               the overlay advances the opening and sets priorAsOf. This is
//               production's shape.
//   same-day  - the opening is already on the observation day with a
//               hand-set priorAsOf Sep 20. Nothing in production builds
//               this: the committed plan never carries priorAsOf. It is
//               kept to show the list mirrors the walk there too.
// Current pay period Oct 9 - Oct 22; previous Sep 25 - Oct 8; before that
// Sep 11 - Sep 24. Pay 1,400; household budget 400. Every expectation is
// written by hand. No household figure enters.
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
// Late-payment readers (the review repair). Other spending is the household
// budget's own Other row for the period; a named debit is the observer's
// possible-payment candidate; counted() is Forecast's own classification.
const otherSpent = r => {
  const row = (r.current.householdBudget || []).find(x => x && x.otherSpending);
  return row && typeof row.spent === 'number' ? row.spent : 0;
};
const named = r => (r.packet.transactions || []).filter(t => t && t.nearDueBillCandidate)
  .map(t => [t.date, t.nearDueBillCandidate.id, t.nearDueBillCandidate.date, t.nearDueBillCandidate.offsetDays]);
const counted = (r, date) => (r.packet.transactions || []).filter(t => t && t.date === date && Number(t.amount) > 0)
  .map(t => F.classifyCurrentPeriodTransaction(t, r.plan, { packet: r.packet, currentPeriodActuals: r.packet }).householdSpending);
// The figures of one period, in the order every late-payment case states
// them: bill load, Other spending, budget hold, Balance After Deductions.
const figures = r => [r.current.periodBillLoad, otherSpent(r), r.current.budgetHold, r.current.balanceAfterDeductions];
const toConfirm = (r, date) => {
  const rows = rowsFor(r.current, 'water');
  assert.deepEqual(rows.map(row => [row.date, row.settlement, row.planned, row.remaining]), [[date, 'unverified', 120, 120]],
    'the carried bill is listed once, to confirm, for its full 120');
  assert.notEqual(rows[0].status, 'PAID', 'never Paid on a late debit');
  assert.deepEqual(r.represented, [], 'nothing is named on representedEvents');
  assert.deepEqual(r.observed, [], 'no represented actual is created');
  assert.deepEqual(r.walk.filter(e => e.id === 'water' && e.date === date).map(e => e.amount), [-120],
    'the cash walk deducts it once');
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

console.log('=== #953: an unproven recurring bill from the last closed pay period ===');

check('an unpaid recurring bill from the previous closed period is listed once, to confirm', () => {
  const r = run();
  assert.equal(r.asOf, '2026-10-14', 'the live overlay advanced the opening');
  const rows = rowsFor(r.current, 'water');
  assert.equal(rows.length, 1, 'one current-period row');
  assert.equal(rows[0].date, '2026-10-01', 'keeps its real due date');
  assert.equal(rows[0].settlement, 'unverified', 'to confirm, not paid');
  assert.notEqual(rows[0].status, 'PAID');
  assert.equal(rows[0].remaining, 120);
  assert.equal(rows[0].planned, 120);
  // Hydro Oct 12 (90) + the carried water (120).
  assert.equal(r.current.remainingBills, 210, 'counted once in remaining bills');
  assert.equal(r.current.periodBillLoad, 210, 'counted once in the period bill load');
  assert.equal(r.current.balanceAfterDeductions, 790, '1,400 - 210 - 400 = 790');
  assert.deepEqual(r.walk.filter(e => e.id === 'water').map(e => [e.date, e.amount]), [['2026-10-01', -120]],
    'the cash walk deducts it once');
  for (const list of [r.action, r.assistantBills]) {
    const named = list.filter(b => b.id === 'water');
    assert.equal(named.length, 1, 'Talk names it once');
    assert.deepEqual([named[0].date, named[0].settlement, named[0].remaining], ['2026-10-01', 'unverified', 120]);
  }
});

check('control: every other bill reads the same with or without the carried bill', () => {
  const withWater = run();
  const without = run(w => { w.bills = [Object.assign({}, HYDRO)]; });
  assert.deepEqual(rowsFor(withWater.current, 'hydro'), rowsFor(without.current, 'hydro'), 'the hydro row is identical');
  assert.equal(without.current.remainingBills, 90);
  assert.equal(without.current.periodBillLoad, 90);
  assert.equal(without.current.balanceAfterDeductions, 910, '1,400 - 90 - 400 = 910');
  assert.equal(withWater.current.remainingBills - without.current.remainingBills, 120, 'the list moves by the carried 120 only');
  // The next period is untouched: it holds Nov 1 water only either way.
  const next = r => r.advice.payPeriodViews.find(v => v.start === '2026-10-23');
  assert.deepEqual(rowsFor(next(withWater), 'water').map(row => row.date), ['2026-11-01']);
  assert.equal(rowsFor(next(withWater), 'hydro').length, 0);
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

check('a pending matching debit does not settle it: still listed once, still deducted once', () => {
  const r = run(w => w.transactions.push(H.lm(waterDebit('2026-10-01', { pending: true }))));
  assert.deepEqual(r.observed.map(a => a.date), ['2026-10-01'], 'positive control: the pending match reached the packet');
  assert.deepEqual(r.represented, [], 'pending is never on representedEvents');
  const rows = rowsFor(r.current, 'water');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].settlement, rows[0].remaining], ['unverified', 120], 'to confirm: a pending debit is not posted evidence');
  assert.notEqual(rows[0].status, 'PAID');
  assert.equal(r.current.remainingBills, 210);
  assert.equal(owed(r.walk.map(e => ({ id: e.id, date: e.date, remaining: -e.amount })), 'water', '2026-10-01'), 1);
  assert.equal(owed(r.action, 'water', '2026-10-01'), 1);
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
  // What each cell must be: 1 = all three owe it once, 0 = none owes it.
  // Advancing is production's shape: the overlay names posted, owner and
  // schedule-trust settlements on representedEvents. In the hand-built
  // same-day shape the overlay does not advance, so it names only what the
  // opening already carried (the owner record); the walk still owes the
  // rest, exactly as on main, and the list says the same thing.
  const expected = { advancing: { unpaid: 1, posted: 0, pending: 1, owner: 0, 'schedule trust': 0 },
    'same-day': { unpaid: 1, posted: 1, pending: 1, owner: 0, 'schedule trust': 1 } };
  for (const shape of ['advancing', 'same-day']) {
    for (const [name, patch] of Object.entries(states)) {
      const r = run(w => { w.shape = shape; patch(w); });
      const budget = owed(rowsFor(r.current, 'water'), 'water', '2026-10-01');
      const walk = r.walk.filter(e => e.id === 'water' && e.date === '2026-10-01').length;
      const talk = owed(r.action, 'water', '2026-10-01');
      if (name === 'pending') assert.deepEqual(r.represented, [], `${shape}, pending: never on representedEvents`);
      assert.deepEqual([budget, walk, talk], [expected[shape][name], expected[shape][name], expected[shape][name]],
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

check('trust: an estimated bill stays estimated when carried', () => {
  const r = run(w => { w.bills[0].confidence = 'estimated'; });
  const rows = rowsFor(r.current, 'water');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].confidence, 'estimated');
  assert.equal(rows[0].settlement, 'unverified');
});

check('the carried recurring row matches the one-off carry it mirrors', () => {
  const recurring = run();
  const once = run(w => { w.bills[0] = { id: 'water', label: 'Invented water', amount: 120, frequency: 'once',
    date: '2026-10-01', confidence: 'confirmed', payee: 'Invented water co' }; });
  const a = rowsFor(recurring.current, 'water')[0], b = rowsFor(once.current, 'water')[0];
  for (const k of ['date', 'settlement', 'status', 'glanceKind', 'remaining', 'planned', 'amount', 'actual']) {
    assert.deepEqual(a[k], b[k], 'same ' + k + ' as the one-off');
  }
  assert.equal(recurring.current.remainingBills, once.current.remainingBills);
  assert.equal(recurring.current.balanceAfterDeductions, once.current.balanceAfterDeductions);
});

check('period boundaries: only the immediately preceding closed period is carried', () => {
  // The day of the month decides where the occurrence falls.
  const listedDates = day => rowsFor(run(w => { w.bills[0].day = day; w.datedOpening = '2026-09-01'; }).current, 'water')
    .map(row => row.date);
  assert.deepEqual(listedDates(8), ['2026-10-08'], 'Oct 8, the last day of the closed period: carried');
  assert.deepEqual(listedDates(25), ['2026-09-25'], 'Sep 25, the first day of the closed period: carried');
  assert.deepEqual(listedDates(9), ['2026-10-09'], 'Oct 9, payday: an ordinary current-period row, once');
  assert.deepEqual(listedDates(22), ['2026-10-22'], 'Oct 22, the last day of this period: an ordinary row, once');
  assert.deepEqual(listedDates(24), [], 'Sep 24, the last day two periods back: history only');
  assert.deepEqual(listedDates(15), ['2026-10-15'], 'Sep 15 two periods back is not listed; Oct 15 is this period\'s own');
});

check('a bill inside the dated opening is neither listed nor deducted', () => {
  // Dated opening Sep 28: Sep 26 is in the closed period but on or before
  // the dated opening, so it is inside that opening's cash.
  const r = run(w => { w.bills[0].day = 26; w.datedOpening = '2026-09-28'; });
  assert.deepEqual(rowsFor(r.current, 'water').map(row => row.date), [], 'Sep 26 is not carried; Oct 26 is next period');
  assert.equal(r.walk.filter(e => e.id === 'water').length, 0, 'the walk does not deduct it either');
  assert.equal(r.current.remainingBills, 90);
});

check('equal dates: a bill dated exactly on the dated opening is inside it', () => {
  // Dated opening Sep 28 and a bill on the 28th: the walk carries what falls
  // strictly after the dated opening, so Sep 28 is inside it. The day after
  // (Sep 29) is carried.
  const on = run(w => { w.bills[0].day = 28; w.datedOpening = '2026-09-28'; });
  assert.deepEqual(rowsFor(on.current, 'water').map(row => row.date), [], 'Sep 28 is not listed');
  assert.equal(on.walk.filter(e => e.id === 'water').length, 0, 'and not deducted');
  const after = run(w => { w.bills[0].day = 29; w.datedOpening = '2026-09-28'; });
  assert.deepEqual(rowsFor(after.current, 'water').map(row => [row.date, row.settlement]), [['2026-09-29', 'unverified']]);
  assert.equal(after.walk.filter(e => e.id === 'water' && e.date === '2026-09-29').length, 1);
});

check('consecutive periods: the rule moves on with each payday', () => {
  // Observed on the next payday, Oct 23 (period Oct 23 - Nov 5). Nothing was
  // ever paid. Hydro Oct 12 is now the previous period's unproven bill and
  // is carried once. Water Oct 1 is two periods back: history only in the
  // list (the lead's bound), though the walk still deducts it. Water Nov 1
  // is this period's own row.
  const r = run(w => { w.asOf = '2026-10-23';
    w.transactions.push(H.lm(Object.assign({}, PAYROLL, { date: '2026-10-23' }))); });
  assert.equal(r.asOf, '2026-10-23');
  assert.deepEqual([r.current.start, r.current.end], ['2026-10-23', '2026-11-05']);
  assert.deepEqual(rowsFor(r.current, 'hydro').map(row => [row.date, row.settlement, row.remaining]),
    [['2026-10-12', 'unverified', 90]], 'hydro Oct 12 is carried once');
  assert.deepEqual(rowsFor(r.current, 'water').map(row => row.date), ['2026-11-01'], 'water Oct 1 is no longer listed');
  // 90 carried + 120 for Nov 1.
  assert.equal(r.current.periodBillLoad, 210);
  assert.equal(r.walk.filter(e => e.id === 'water' && e.date === '2026-10-01').length, 1,
    'known bound: the walk still deducts the two-periods-old bill');
});

check('repeat and two in a row: a biweekly bill unproven in both periods is listed once per occurrence', () => {
  // A biweekly bill of 40 falls on Sep 30 (the closed period) and Oct 14
  // (today). Both are unproven: one carried row and one current row.
  const r = run(w => { w.bills.push({ id: 'lessons', label: 'Invented lessons', amount: 40, frequency: 'biweekly',
    anchor: '2026-09-30', confidence: 'confirmed', payee: 'Invented lessons co' }); });
  assert.deepEqual(rowsFor(r.current, 'lessons').map(row => row.date).sort(), ['2026-09-30', '2026-10-14']);
  assert.equal(r.walk.filter(e => e.id === 'lessons' && e.date <= r.current.end).length, 2, 'the walk deducts each once');
  // Water 120 carried + hydro 90 + lessons 40 + 40.
  assert.equal(r.current.periodBillLoad, 290);
  // The same inputs read twice give the same answer: nothing is consumed.
  const w = world();
  const built = H.dataOf(w);
  const first = read(w, built), second = read(w, built);
  assert.deepEqual(JSON.stringify(first.current), JSON.stringify(second.current), 'a second read is identical');
});

check('genuine ambiguity: two look-alike bills and one payment leave both to confirm', () => {
  // Two 50 bills to the same payee on Oct 1 and one posted 50 debit. No
  // tie-break: neither settles, so both are carried and both are deducted.
  const r = run(w => {
    w.bills = [{ id: 'water', label: 'Invented water', amount: 50, frequency: 'monthly', day: 1, confidence: 'confirmed',
      payee: 'Invented city utility' }, { id: 'waste', label: 'Invented waste', amount: 50, frequency: 'monthly', day: 1,
      confidence: 'confirmed', payee: 'Invented city utility' }];
    w.transactions.push(H.lm({ date: '2026-10-01', amount: 50, payee: 'Invented city utility', account: 'chequing-a',
      category: 'Utilities' }));
  });
  for (const id of ['water', 'waste']) {
    assert.deepEqual(rowsFor(r.current, id).map(row => [row.date, row.settlement]), [['2026-10-01', 'unverified']], id);
    assert.equal(r.walk.filter(e => e.id === id && e.date === '2026-10-01').length, 1, id + ' is deducted once');
  }
  assert.equal(r.current.remainingBills, 100);
});

check('other views: the carried row is on the current period only; the closed period keeps its own row', () => {
  const r = run();
  const holders = r.advice.payPeriodViews.filter(v => rowsFor(v, 'water').some(row => row.date === '2026-10-01'))
    .map(v => v.start).sort();
  assert.deepEqual(holders, ['2026-09-25', '2026-10-09'], 'its own closed period (history) and the current period');
  const closed = r.advice.payPeriodViews.find(v => v.start === '2026-09-25');
  const own = rowsFor(closed, 'water');
  assert.equal(own.length, 1, 'once in its own period');
  assert.notEqual(own[0].status, 'PAID', 'and never Paid there without evidence');
  for (const v of r.advice.payPeriodViews.filter(x => x.start > '2026-10-09')) {
    assert.equal(rowsFor(v, 'water').filter(row => row.date === '2026-10-01').length, 0, 'not in ' + v.start);
  }
});

check('a payment on the boundary day settles the boundary-day bill', () => {
  const r = run(w => { w.bills[0].day = 8; w.transactions.push(H.lm(waterDebit('2026-10-08'))); });
  assert.deepEqual(r.represented, ['2026-10-08']);
  assert.equal(rowsFor(r.current, 'water').length, 0, 'paid on Oct 8: not carried');
  assert.equal(r.walk.filter(e => e.id === 'water').length, 0);
  assert.equal(r.current.remainingBills, 90);
});

// --- Review repair (BLOCKERS FOUND on 1bcdce6d): a bill from the closed
// period paid late, in the new period, must be counted once. The carried
// row stays reserved "to confirm" (the cash walk's own treatment), so the
// debit that may be its payment is held out of household spending.
// By hand, Oct 9 - Oct 22, water 120 carried + hydro 90:
//   bill load 210; Other spending 0; budget hold 400;
//   Balance After Deductions 1,400 - 210 - 400 = 790, the unpaid figure.
// On 1bcdce6d the same 120 was also Other spending: hold 520, balance 670.

check('paid late in the new period (the reviewer\'s case): the payment is counted once', () => {
  const unpaid = figures(run());
  assert.deepEqual(unpaid, [210, 0, 400, 790], 'control: unpaid');
  for (const [date, late] of [['2026-10-10', 9], ['2026-10-13', 12]]) {
    for (const shape of ['advancing', 'same-day']) {
      const r = run(w => { w.shape = shape; w.transactions.push(H.lm(waterDebit(date))); });
      assert.deepEqual(named(r), [[date, 'water', '2026-10-01', late]], `${shape}, ${date}: named on the Oct 1 occurrence`);
      assert.deepEqual(counted(r, date), [false], `${shape}, ${date}: the debit is not household spending`);
      toConfirm(r, '2026-10-01');
      assert.deepEqual(figures(r), [210, 0, 400, 790], `${shape}, ${date}: 1,400 - 210 - 400 = 790, once`);
      assert.deepEqual(figures(r), unpaid, `${shape}, ${date}: exactly the unpaid figures`);
    }
  }
});

check('late payment on the period boundary: the first day of the new period', () => {
  // Water due Oct 8, the last day of the closed period, paid Oct 9 (payday,
  // the first day of the new one). Water due Oct 1 paid Oct 9 likewise.
  for (const [day, due, late] of [[8, '2026-10-08', 1], [1, '2026-10-01', 8]]) {
    const r = run(w => { w.bills[0].day = day; w.transactions.push(H.lm(waterDebit('2026-10-09'))); });
    assert.deepEqual(named(r), [['2026-10-09', 'water', due, late]]);
    assert.deepEqual(counted(r, '2026-10-09'), [false]);
    toConfirm(r, due);
    assert.deepEqual(figures(r), [210, 0, 400, 790], `due ${due}, paid Oct 9: counted once`);
  }
});

// --- Final review round: the same payment made late but still inside the
// CLOSED period (due Oct 1, paid Oct 8). That debit is already spending in
// the closed period's own figures. Carrying the bill as well would count it
// a second time, in the new period. So an occurrence that a closed-period
// debit is named for is not carried: the new period reads as on main.
// By hand, Oct 9 - Oct 22: hydro 90 only; 1,400 - 90 - 400 = 910.

const closedNamed = r => (r.packet.transactions || []).filter(t => t && t.closedPeriodBillCandidate)
  .map(t => [t.date, t.closedPeriodBillCandidate.id, t.closedPeriodBillCandidate.date, t.closedPeriodBillCandidate.offsetDays]);

check('paid late inside the closed period: not carried, counted once, as on main', () => {
  for (const [date, late] of [['2026-10-08', 7], ['2026-10-06', 5]]) {
    for (const shape of ['advancing', 'same-day']) {
      const r = run(w => { w.shape = shape; w.transactions.push(H.lm(waterDebit(date))); });
      assert.deepEqual(closedNamed(r), [[date, 'water', '2026-10-01', late]], `${shape}, ${date}: named for the Oct 1 occurrence`);
      assert.deepEqual(named(r), [], `${shape}, ${date}: not a possible-payment hold; the closed period is untouched`);
      assert.deepEqual(counted(r, date), [true], `${shape}, ${date}: still spending in its own closed period`);
      assert.deepEqual(rowsFor(r.current, 'water'), [], `${shape}, ${date}: not carried into the new period`);
      assert.deepEqual(figures(r), [90, 0, 400, 910], `${shape}, ${date}: 1,400 - 90 - 400 = 910, once`);
      assert.deepEqual(r.represented, [], 'nothing settles');
      const closed = r.advice.payPeriodViews.find(v => v.start === '2026-09-25');
      assert.deepEqual(rowsFor(closed, 'water').map(row => [row.date, row.status === 'PAID']), [['2026-10-01', false]],
        'its own period keeps the row, never Paid on a late debit');
    }
  }
  // Within three days (the existing near-due naming), late or early: the same.
  for (const date of ['2026-10-04', '2026-09-28']) {
    const r = run(w => w.transactions.push(H.lm(waterDebit(date))));
    assert.deepEqual(named(r).map(n => [n[1], n[2]]), [['water', '2026-10-01']], `${date}: named by the near-due rule`);
    assert.deepEqual(rowsFor(r.current, 'water'), [], `${date}: not carried`);
    assert.deepEqual(figures(r), [90, 0, 400, 910], `${date}: 910`);
  }
});

check('closed-period reach has the same edges as the hold', () => {
  // Another payee or another account in the closed period names nothing:
  // the bill is still carried, to confirm. 1,400 - 210 - 400 = 790.
  for (const extra of [{ payee: 'Invented florist' }, { account: 'chequing-b' }]) {
    const r = run(w => w.transactions.push(H.lm(waterDebit('2026-10-08', extra))));
    assert.deepEqual(closedNamed(r), []);
    toConfirm(r, '2026-10-01');
    assert.deepEqual(figures(r), [210, 0, 400, 790], JSON.stringify(extra));
  }
  // A pending closed-period debit names nothing either (posted only).
  const pending = run(w => w.transactions.push(H.lm(waterDebit('2026-10-08', { pending: true }))));
  assert.deepEqual(closedNamed(pending), []);
  toConfirm(pending, '2026-10-01');
  // Paid in the closed period AND a second debit in the new one: nothing is
  // carried, so nothing is held, and the second debit is spending.
  // 1,400 - 90 - 520 = 790.
  const both = run(w => w.transactions.push(H.lm(waterDebit('2026-10-08')), H.lm(waterDebit('2026-10-10'))));
  assert.deepEqual(rowsFor(both.current, 'water'), []);
  assert.deepEqual(counted(both, '2026-10-10'), [true], 'no carried reserve, no hold');
  assert.deepEqual(figures(both), [90, 120, 520, 790]);
  // Equal dates: a debit on the due date itself settles (the matcher's), and
  // one on the first day of the closed period for a bill due that day too.
  const first = run(w => { w.bills[0].day = 25; w.transactions.push(H.lm(waterDebit('2026-10-08'))); });
  assert.deepEqual(closedNamed(first), [['2026-10-08', 'water', '2026-09-25', 13]], 'due on the first day, paid on the last');
  assert.deepEqual(figures(first), [90, 0, 400, 910]);
  // A bill two periods back is never on the list; a closed-period debit
  // after it changes nothing here.
  const older = run(w => { w.bills[0].day = 24; w.transactions.push(H.lm(waterDebit('2026-10-08'))); });
  assert.deepEqual(closedNamed(older), [], 'Sep 24 is not in the closed period: not named');
  assert.deepEqual(figures(older), [90, 0, 400, 910]);
});

check('mutation: without the closed-period rule, or without the hold, the double count returns', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../public/forecast.js'), 'utf8');
  const mutantOf = (from, to) => {
    assert.equal(src.split(from).length - 1, 1, 'the mutation is aimed at one line: ' + from.trim());
    const sandbox = { module: { exports: {} }, console };
    vm.runInNewContext(src.replace(from, to), sandbox, { filename: 'forecast-mutant.js' });
    return sandbox.module.exports;
  };
  const balance = (engine, w) => {
    const { data, packet, error } = H.dataOf(w);
    assert.equal(error, null);
    const asOf = data.plan.opening.asOf;
    const advice = engine.recommend(JSON.parse(JSON.stringify(data.plan)), asOf,
      { debts: JSON.parse(JSON.stringify(data.debts || [])), currentPeriodActuals: JSON.parse(JSON.stringify(packet)) });
    const current = advice.payPeriodViews.find(v => v.start <= asOf && v.end >= asOf);
    return [current.periodBillLoad, current.balanceAfterDeductions];
  };
  const closedCase = () => world(w => w.transactions.push(H.lm(waterDebit('2026-10-08'))));
  const lateCase = () => world(w => w.transactions.push(H.lm(waterDebit('2026-10-10'))));
  // Positive control: the unmutated source, loaded the same way, is right.
  const same = mutantOf('    const paidInClosedPeriod = closedPeriodBillCandidateKeys(opts, span);',
    '    const paidInClosedPeriod = closedPeriodBillCandidateKeys(opts, span); // same');
  assert.deepEqual(balance(same, closedCase()), [90, 910], 'control: paid Oct 8, 910');
  assert.deepEqual(balance(same, lateCase()), [210, 790], 'control: paid Oct 10, 790');
  // Mutant 1: the closed-period rule removed. The bill is carried again on
  // top of the closed period's spending: the 790 the reviewer found.
  const noDrop = mutantOf("      if (paidInClosedPeriod.has(event.id + '@' + event.date)) return false;\n", '');
  assert.deepEqual(balance(noDrop, closedCase()), [210, 790], 'mutant 1 double counts the Oct 8 payment');
  // Mutant 2: the hold removed. The Oct 10 debit is spending and the bill
  // is carried: the 670 the first review found.
  const noHold = mutantOf('        || carriedRecurringBillReservedIn(plan, opts, tx, nearDue, nearDueCycle))) {', ')) {');
  assert.deepEqual(balance(noHold, lateCase()), [210, 670], 'mutant 2 double counts the Oct 10 payment');
});

check('late payment of a different amount: still one reserve, never both', () => {
  // Amount never identifies (the bill's own identity rule). 80 or 150 from
  // the bill's payee is held the same way; the bill stays reserved at its
  // planned 120 and nothing is marked paid.
  for (const amount of [80, 150]) {
    const r = run(w => w.transactions.push(H.lm(waterDebit('2026-10-10', { amount }))));
    assert.deepEqual(named(r), [['2026-10-10', 'water', '2026-10-01', 9]], String(amount));
    assert.deepEqual(counted(r, '2026-10-10'), [false], String(amount));
    toConfirm(r, '2026-10-01');
    assert.deepEqual(figures(r), [210, 0, 400, 790], `a ${amount} debit: 210 reserved, nothing counted twice`);
  }
});

check('more than two weeks late is still the same bill', () => {
  // Observed Oct 21; water Oct 1 paid Oct 20, nineteen days late.
  const r = run(w => { w.asOf = '2026-10-21'; w.transactions.push(H.lm(waterDebit('2026-10-20'))); });
  assert.deepEqual(named(r), [['2026-10-20', 'water', '2026-10-01', 19]]);
  toConfirm(r, '2026-10-01');
  assert.deepEqual(figures(r), [210, 0, 400, 790]);
});

check('repeat: two late debits and one carried bill hold one debit, and count the other', () => {
  // 240 left the account. One reserve stands in for one debit: 120 stays
  // reserved on the bill and the other 120 is spending. 1,400 - 210 - 520.
  const r = run(w => w.transactions.push(H.lm(waterDebit('2026-10-10')), H.lm(waterDebit('2026-10-13'))));
  assert.equal(named(r).length, 2, 'positive control: both debits are named');
  assert.deepEqual([counted(r, '2026-10-10'), counted(r, '2026-10-13')], [[false], [true]], 'the earliest is held');
  toConfirm(r, '2026-10-01');
  assert.deepEqual(figures(r), [210, 120, 520, 670], '120 reserved + 120 spent = the 240 that left');
  // Equal dates: two debits on the same day still hold exactly one.
  const same = run(w => w.transactions.push(H.lm(waterDebit('2026-10-10')), H.lm(waterDebit('2026-10-10'))));
  assert.equal(named(same).length, 2, 'positive control: both same-day debits are named');
  assert.deepEqual(counted(same, '2026-10-10').slice().sort(), [false, true], 'same day: one held, one counted');
  assert.deepEqual(figures(same), [210, 120, 520, 670], 'same day: 120 reserved + 120 spent');
});

check('no identity, no hold: another payee or another account stays counted', () => {
  // The bill is unpaid and a separate 120 was spent: both are real.
  const florist = run(w => w.transactions.push(H.lm(waterDebit('2026-10-10', { payee: 'Invented florist' }))));
  assert.deepEqual(named(florist), []);
  assert.deepEqual(figures(florist), [210, 120, 520, 670], 'another payee');
  const elsewhere = run(w => w.transactions.push(H.lm(waterDebit('2026-10-10', { account: 'chequing-b' }))));
  assert.deepEqual(named(elsewhere), []);
  assert.deepEqual(figures(elsewhere), [210, 120, 520, 670], 'the right payee on another account');
});

check('no reserve, no hold: a debit is never deducted nowhere', () => {
  // The hold follows the walk's carry. Where nothing is carried into this
  // period, the debit stays spending. 1,400 - 90 - 520 = 790 in each case.
  const owner = run(w => { w.ownerRepresented = [{ id: 'water', date: '2026-10-01' }];
    w.transactions.push(H.lm(waterDebit('2026-10-10'))); });
  assert.equal(rowsFor(owner.current, 'water').length, 0, 'owner record: nothing carried');
  assert.deepEqual(figures(owner), [90, 120, 520, 790], 'owner record: the later debit is spending');
  const paid = run(w => w.transactions.push(H.lm(waterDebit('2026-10-01')), H.lm(waterDebit('2026-10-10'))));
  assert.equal(rowsFor(paid.current, 'water').length, 0, 'paid on its date: nothing carried');
  assert.deepEqual(figures(paid), [90, 120, 520, 790], 'paid on its date: a second charge is spending');
  // Two periods back (Sep 24): history only in the list, so no row stands
  // in for the debit here and it stays counted.
  const older = run(w => { w.bills[0].day = 24; w.transactions.push(H.lm(waterDebit('2026-10-09'))); });
  assert.deepEqual(rowsFor(older.current, 'water').map(row => row.date), [], 'two periods back: not listed');
  assert.deepEqual(counted(older, '2026-10-09'), [true]);
  assert.deepEqual(figures(older), [90, 120, 520, 790], 'two periods back: the debit is spending');
  // A bill class this rule never lists (debt-linked) is never held either.
  const linked = run(w => { w.bills[0].debtId = 'invented-debt'; w.transactions.push(H.lm(waterDebit('2026-10-10'))); });
  assert.equal(rowsFor(linked.current, 'water').filter(row => row.date === '2026-10-01').length, 0, 'debt-linked: not listed');
  assert.deepEqual(counted(linked, '2026-10-10'), [true], 'debt-linked: the debit stays counted');
});

check('fixed context: the hold belongs to the period the bill is carried into, and to nothing else', () => {
  const r = run(w => w.transactions.push(H.lm(waterDebit('2026-10-10'))));
  // The closed period keeps its own unproven row and the next period its
  // own Nov 1 bill; neither gains or loses anything from the hold.
  const closed = r.advice.payPeriodViews.find(v => v.start === '2026-09-25');
  assert.deepEqual(rowsFor(closed, 'water').map(row => [row.date, row.status === 'PAID']), [['2026-10-01', false]]);
  const next = r.advice.payPeriodViews.find(v => v.start === '2026-10-23');
  assert.deepEqual(rowsFor(next, 'water').map(row => row.date), ['2026-11-01']);
  const control = run().advice.payPeriodViews.find(v => v.start === '2026-10-23');
  assert.equal(next.periodBillLoad, control.periodBillLoad, 'the next period plans the same bills');
  // Hydro reads exactly as it does with the bill unpaid.
  assert.deepEqual(rowsFor(r.current, 'hydro'), rowsFor(run().current, 'hydro'));
  // The same inputs read twice give the same answer.
  const w = world(v => v.transactions.push(H.lm(waterDebit('2026-10-10'))));
  const built = H.dataOf(w);
  assert.equal(JSON.stringify(read(w, built).current), JSON.stringify(read(w, built).current));
});

check('a pending late debit keeps its incumbent path: it is not named', () => {
  // The possible-payment rule reads posted debits only (#962 D3). The bill
  // stays to confirm; nothing settles.
  const r = run(w => w.transactions.push(H.lm(waterDebit('2026-10-10', { pending: true }))));
  assert.deepEqual(named(r), []);
  toConfirm(r, '2026-10-01');
});

check('bills the cash walk does not carry as joint cash are not listed', () => {
  const carried = patch => rowsFor(run(patch).current, 'water').filter(row => row.date === '2026-10-01').length;
  assert.equal(carried(), 1, 'positive control');
  assert.equal(carried(w => { w.bills[0] = Object.assign({}, WATER, { frequency: 'once', date: '2026-10-01' }); }), 1,
    'a one-off keeps its own carry: still once');
  assert.equal(carried(w => { w.bills[0].payingAccount = 'held-x';
    w.planExtra = p => { p.startingCash.heldElsewhere = [{ id: 'held-x', value: 0 }]; }; }), 0, 'held-elsewhere payer');
  assert.equal(carried(w => { w.bills[0].needsDate = true; }), 0, 'undated bill');
  assert.equal(carried(w => { w.bills[0].debtId = 'invented-debt'; }), 0, 'debt-linked bill');
});

check('timezone edge: the period closes on the household calendar day, not the UTC day', () => {
  // 22:30 on Oct 8 in Vancouver is already Oct 9 in UTC. The household is
  // still in Sep 25 - Oct 8, so the Oct 1 bill is this period's own row and
  // nothing is carried. Two hours later (00:30 on Oct 9) the period has
  // closed and the same unproven bill is carried once.
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
  assert.deepEqual(rowsFor(afterMidnight.current, 'water').map(row => [row.date, row.settlement]),
    [['2026-10-01', 'unverified']], 'carried once into the new period');
  assert.equal(afterMidnight.walk.filter(e => e.id === 'water' && e.date === '2026-10-01').length, 1);
});

check('the process timezone moves nothing', () => {
  const expected = JSON.stringify(['2026-10-14', '2026-10-09', '2026-10-22', [['2026-10-01', 'unverified', 120]],
    [['2026-10-01', -120]]]);
  for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Vancouver']) {
    const out = execFileSync(process.execPath, [__filename, '--tz-probe'],
      { env: Object.assign({}, process.env, { TZ: zone }), encoding: 'utf8' });
    const line = out.split('\n').find(l => l.startsWith('TZ-PROBE ')) || '';
    assert.equal(line.slice(9), expected, zone);
  }
});

console.log(`${passed} passed`);
