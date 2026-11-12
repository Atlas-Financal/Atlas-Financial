'use strict';
/* Forecast.baselineTrajectory per-pay-period extra-debt attribution, read
 * straight from the engine.
 *
 * Each pay period that carries an extra debt payment publishes, beside the
 * authoritative amount, the walk-owned ordered per-debt split of that payment
 * (stage3.extras.allocations). The Budget no longer renders a pay-period
 * drilldown, but this publication is part of the engine's contract, so it stays
 * observed here independently of any page:
 *
 *  - only the pay period containing the extra event carries its attribution,
 *    and a period with no extra payment carries none;
 *  - allocations follow the household's own order, highest interest first, and
 *    a later period names its own target, never the cleared earlier one;
 *  - the published amount stays authoritative (the lines add up to it), and the
 *    split recomputes when the extra-debt knob changes.
 *
 * Invented world: two revolving cards, Triangle $200 at 19.99% and MBNA $5,000
 * at 12.99%; $1,000 a month of extra debt payment; biweekly $2,600 payroll.
 * Hand arithmetic: Triangle is paid first (higher rate) and cleared by its own
 * balance plus about half a month of interest (200 x 19.99% x 15 / 365 = $1.64,
 * so $201.6 to $201.7); the rest of the $1,000 flows to MBNA; later months have
 * Triangle cleared, so the whole payment goes to MBNA.
 *
 * `node test/test-baseline-trajectory-extra-debt-attribution.js`
 */
const assert = require('node:assert/strict');
const F = require('../public/forecast.js');

let checks = 0;
function check(label, run) { run(); checks++; console.log('  PASS  ' + label); }
const cents = n => Math.round(Number(n) * 100);

function plan() {
  return {
    windowDays: 91,
    startingCash: { amount: 20000 },
    defaults: { targetBuffer: 0, extraDebtMonthly: 1000 },
    income: [{ id: 'payroll', label: 'Seaspan', frequency: 'biweekly', anchor: '2026-01-02',
      amount: 2600, confidence: 'confirmed' }],
    obligations: [], bills: [], commitments: [],
    budget: { basis: 'ytd', categories: [
      { id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedWeekly: 140 },
    ] },
    opening: { asOf: '2026-01-01' },
    nextDollar: { policy: 'true-surplus-highest-interest',
      eligibleDebts: 'revolving-cards-and-heloc', provenance: 'owner-stated' },
  };
}
function debts() {
  return [
    { id: 'tri', label: 'Triangle Mastercard', structure: 'Revolving card',
      balance: 200, pending: 0, rate: 19.99, minimumPayment: 25, paymentDay: 15, confidence: 'verified' },
    { id: 'mbna', label: 'MBNA Mastercard', structure: 'Revolving card',
      balance: 5000, pending: 0, rate: 12.99, minimumPayment: 100, paymentDay: 15, confidence: 'verified' },
  ];
}
const trajectory = opts => F.baselineTrajectory(plan(), debts(), '2026-01-01', Object.assign({ weeklyVariable: 400 }, opts));
const withExtra = t => t.payPeriods.filter(pp => pp.stage3 && pp.stage3.extras && pp.stage3.extras.amount > 0);

check('only a pay period containing an extra payment carries its attribution', () => {
  const t = trajectory();
  assert.equal(t.status, 'ready');
  const periods = withExtra(t);
  assert.ok(periods.length >= 2, 'at least two extra-payment periods exist');
  for (const pp of periods) {
    assert.ok(Array.isArray(pp.stage3.extras.allocations) && pp.stage3.extras.allocations.length > 0, pp.payday + ' carries allocations');
  }
  const zero = t.payPeriods.filter(pp => pp.stage3 && pp.stage3.extras
    && pp.stage3.extras.status === 'calculated' && pp.stage3.extras.amount === 0);
  assert.ok(zero.length > 0, 'zero-extra periods exist');
  for (const pp of zero) assert.equal(pp.stage3.extras.allocations, undefined, pp.payday + ': no attribution without an extra payment');
});

check('the first extra payment clears the higher-rate card, then flows to the next; the lines add up to the published amount', () => {
  const first = withExtra(trajectory())[0];
  assert.equal(first.stage3.extras.amount, 1000);
  const [tri, mbna, ...rest] = first.stage3.extras.allocations;
  assert.equal(rest.length, 0);
  assert.deepEqual([tri.debtId, tri.label, tri.status], ['tri', 'Triangle Mastercard', 'calculated']);
  assert.deepEqual([mbna.debtId, mbna.label, mbna.status], ['mbna', 'MBNA Mastercard', 'calculated']);
  assert.ok(tri.amount >= 201.6 && tri.amount <= 201.7, 'Triangle: $200 plus about $1.64 of interest, got ' + tri.amount);
  assert.equal(cents(tri.amount) + cents(mbna.amount), 100000, 'the lines add up to the published $1,000.00');
});

check('a later period names its own target, not the cleared earlier one', () => {
  const later = withExtra(trajectory())[1];
  assert.equal(later.stage3.extras.amount, 1000);
  assert.deepEqual(later.stage3.extras.allocations.map(line => [line.debtId, line.amount]), [['mbna', 1000]]);
});

check('the split recomputes from the same inputs when the extra-debt knob changes', () => {
  const lo = withExtra(trajectory({ extraDebtMonthly: 600 }))[0];
  const hi = withExtra(trajectory({ extraDebtMonthly: 1000 }))[0];
  assert.equal(lo.stage3.extras.amount, 600);
  assert.equal(hi.stage3.extras.amount, 1000);
  assert.deepEqual(lo.stage3.extras.allocations.map(line => line.debtId), ['tri', 'mbna']);
  assert.equal(lo.stage3.extras.allocations[0].amount, hi.stage3.extras.allocations[0].amount,
    'the cleared card takes the same payoff');
  assert.equal(cents(lo.stage3.extras.allocations[0].amount) + cents(lo.stage3.extras.allocations[1].amount), 60000);
  assert.ok(lo.stage3.extras.allocations[1].amount < hi.stage3.extras.allocations[1].amount,
    'the residual into the next debt follows the knob');
});

console.log(`\n${checks} baselineTrajectory extra-debt attribution checks passed.`);
