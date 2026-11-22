'use strict';

const assert = require('node:assert/strict');
const fc = require('fast-check');
const H = require('../acceptance/harness');
const Forecast = require('../../public/forecast');

const PAYDAY = '2026-10-09';
const DAY = 86400000;
const money = cents => cents / 100;
const iso = tick => new Date(tick).toISOString().slice(0, 10);
const cents = fc.integer({ min: 1, max: 150000 });
const day = fc.integer({ min: 10, max: 28 });
const confidence = fc.constantFrom('confirmed', 'estimated');

const bill = fc.record({ day, amount: cents, confidence });
const unknownBill = fc.record({ day, amount: fc.constant(null), confidence: fc.constant('unknown') });
function household({ unknown = false, goal = true } = {}) {
  return fc.record({
    pay: cents, hold: fc.integer({ min: 1, max: 90000 }),
    opening: fc.integer({ min: -300000, max: 300000 }), overdraft: cents,
    incomeConfidence: confidence,
    bills: fc.array(unknown ? fc.oneof(bill, unknownBill) : bill, { maxLength: 4 }),
    mortgage: bill, card: bill, heloc: bill,
    goal: goal ? fc.option(cents) : fc.constant(null),
  });
}

function views(x, F) {
  const w = H.baseWorld(PAYDAY);
  w.accounts[0].value = money(x.opening);
  // One Bills stock. No balance in the other operating account to move out at
  // the current-to-next seam. The overdraft facility is headroom, never income.
  w.accounts[1].value = 0;
  w.income[0].amount = money(x.pay);
  w.income[0].confidence = x.incomeConfidence;
  w.budget = [{ ...w.budget[0], plannedPayday: money(x.hold) }];
  w.bills = x.bills.map((b, i) => ({
    id: 'utility-' + i, label: 'Invented utility ' + i, frequency: 'monthly',
    day: b.day, amount: b.amount === null ? null : money(b.amount), confidence: b.confidence,
  }));
  w.obligations = [['mortgage', x.mortgage], ['mbna', x.card]].map(([debtId, b]) => ({
    id: debtId + '-payment', label: 'Invented payment', debtId, effect: 'payment',
    frequency: 'monthly', day: b.day, amount: money(b.amount), confidence: b.confidence,
    payingAccount: 'chequing-a',
  }));
  w.obligations.push({
    id: 'line', label: 'Invented line of credit', debtId: 'heloc', effect: 'capitalise', nonCash: true,
    frequency: 'monthly', day: 1, amount: 1, cashDay: x.heloc.day, cashPayment: money(x.heloc.amount),
    confidence: x.heloc.confidence, payingAccount: 'chequing-a',
  });
  if (x.goal !== null) {
    w.commitments = [{ id: 'books', label: 'Invented books', date: '2026-11-16',
      amount: money(x.goal), confidence: 'estimated', sinkingFund: true }];
    w.savingsPool = { value: w.accounts.find(a => a.id === 'savings').value };
  }
  const result = F.recommend(H.planOf(w), PAYDAY, {
    extraFacilities: [{ id: 'overdraft', cash: 'chequing-a', limit: money(x.overdraft), pending: 0 }],
  });
  const periods = result.payPeriodViews.filter(v => v.timelineRole !== 'past');
  assert.ok(periods.length >= 3, 'publish the current and adjacent projected periods');
  return periods;
}

// Generate an independent calendar one day at a time starting at the input
// payday. The loan's capitalised interest is noncash. Only its cash minimum
// belongs in Credit. In these households each payroll covers exactly 14 days.
function period(x, index, view) {
  const start = Date.parse(PAYDAY) + index * 14 * DAY;
  assert.equal(view.start, iso(start), 'published period start');
  assert.equal(view.end, iso(start + 13 * DAY), 'published period end');
  const days = Array.from({ length: 14 }, (_, i) => new Date(start + i * DAY).getUTCDate());
  const due = b => days.includes(b.day);
  const bills = x.bills.filter(due);
  const hasUnknown = bills.some(b => b.amount === null);
  const amount = b => due(b) ? b.amount : 0;
  const other = bills.reduce((sum, b) => sum + (b.amount ?? 0), 0);
  const mortgage = amount(x.mortgage);
  const credit = amount(x.card) + amount(x.heloc);
  const assigned = other + mortgage + credit;
  return {
    hasUnknown, other, mortgage, credit, assigned, surplus: x.pay - assigned - x.hold,
    estimates: [...bills.map(b => [b, 'utility-' + x.bills.indexOf(b)]),
      [x.mortgage, 'mortgage-payment'], [x.card, 'mbna-payment'], [x.heloc, 'line']]
      .filter(([b]) => due(b) && b.confidence === 'estimated').map(([, id]) => id),
  };
}

function deductions(x, F) {
  views(x, F).forEach((v, i) => {
    const e = period(x, i, v);
    assert.equal(v.incomeTotal, money(x.pay), 'period payroll');
    assert.equal(v.budgetHold, money(x.hold), 'pay-period household budget');
    assert.equal(v.periodBillLoad, e.hasUnknown ? null : money(e.assigned), 'assigned bill load');
    assert.equal(v.balanceAfterDeductions, e.hasUnknown ? null : money(e.surplus), 'balance after deductions');
  });
}

// No held debits, manual payments beyond the minimum, or spending against a
// savings item in this domain. All three are distinct terms when present.
function stack(x, F) {
  views(x, F).forEach((v, i) => {
    const e = period(x, i, v);
    const { surplus, bills } = v.stackSummary;
    if (e.hasUnknown) {
      assert.deepEqual([surplus.amount, surplus.terms, bills.other, bills.mortgage, bills.cardMinimums],
        [null, null, null, null, null], 'an unknown cost withholds the split and surplus');
    } else {
      assert.deepEqual(surplus.terms, {
        income: money(x.pay), bills: money(e.other), household: money(x.hold),
        mortgage: money(e.mortgage), credit: money(e.credit),
      }, 'each Stack term has the input-derived amount');
      assert.equal(surplus.amount, money(e.surplus), 'Stack surplus in exact cents');
    }
    assert.equal(surplus.amount, v.balanceAfterDeductions, 'same-period household remainder');
  });
}

function carry(x, F) {
  let opening = x.opening;
  const vs = views(x, F);
  vs.forEach((v, i) => {
    const close = opening + period(x, i, v).surplus;
    assert.equal(v.opening, money(opening), 'opening from the invented cash ledger');
    assert.equal(v.plannedPeriodClose, money(close), 'pre-transfer closing cash');
    // In this single-stock world the active close carries in full. On a
    // projected payday a positive remainder moves to Savings before the next
    // opening. A deficit always carries in full, even with overdraft room.
    const sweep = i === 0 ? 0 : Math.max(close, 0);
    assert.equal(v.paydaySweep, i === 0 ? null : money(sweep), 'boundary transfer');
    opening = close - sweep;
    if (i + 1 < vs.length) {
      assert.equal(vs[i + 1].opening, sweep === 0 ? v.plannedPeriodClose : money(opening),
        'closing cash after the boundary transfer equals the next opening');
    }
  });
}

function trust(x, F) {
  let cashDependsOnEstimate = false;
  views(x, F).forEach((v, i) => {
    const { estimates } = period(x, i, v);
    const assertEstimated = (tag, label) => assert.equal(tag, 'estimated', label + ' at ' + v.start);
    if (x.incomeConfidence === 'estimated') {
      assertEstimated(v.incomeTrust, 'period income');
      assertEstimated(v.stackSummary.income.total.trust, 'Stack income');
      assertEstimated(v.stackSummary.income.dale.trust, 'Stack payroll line');
    }
    for (const id of estimates) {
      const row = v.bills.find(b => b.id === id);
      assert.ok(row, 'estimated bill ' + id);
      assertEstimated(row.stackBillAmountTrust, 'Stack bill ' + id);
    }
    if (estimates.length) {
      assertEstimated(v.periodBillLoadTrust, 'assigned bills');
      assertEstimated(v.stackSummary.bills.trust, 'Stack bills');
    }
    if (estimates.length || x.incomeConfidence === 'estimated') {
      assertEstimated(v.afterBillsTrust, 'balance after bills');
      assertEstimated(v.balanceAfterDeductionsTrust, 'balance after deductions');
      assertEstimated(v.stackSummary.surplus.trust, 'Stack surplus');
      cashDependsOnEstimate = true;
    }
    // Once a cash flow is estimated, later period-end balances in this chain
    // inherit that uncertainty, even in a period with only confirmed bills.
    if (cashDependsOnEstimate && v.plannedPeriodClose !== null) {
      assertEstimated(v.plannedPeriodCloseTrust, 'closing cash');
    }
    if (i === 0 && x.goal !== null) {
      const { items, totals } = v.stackSummary.savings;
      assert.equal(items[0].needed, money(x.goal), 'goal cost');
      assertEstimated(items[0].trust, 'savings goal');
      assertEstimated(totals.trust, 'savings totals');
    }
  });
}

const property = (id, name, arbitrary, check) => ({
  id, name, arbitrary, check: (input, F = Forecast) => check(input, F),
});
module.exports = { properties: [
  property(3, 'balance after deductions', household({ unknown: true }), deductions),
  property(4, 'Stack surplus', household({ unknown: true }), stack),
  property(5, 'closing cash carries to the next opening', household({ goal: false }), carry),
  property(6, 'estimated inputs qualify dependent figures', household(), trust),
] };
