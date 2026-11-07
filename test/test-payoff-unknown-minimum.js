'use strict';
// PR 1b (H8/H9 engine side): a debt payment whose amount is unknown never
// becomes a $0 or NaN minimum in payoff or renewal. `node test/test-payoff-unknown-minimum.js`
//
// Invented debts and payments only. Expectations are written by hand:
//   card 'x': $1,000 at 20% (card convention), one monthly payment of
//     unknown amount  -> minimum unknown (minimumId 'unknown'), never 'none'
//     ($0) and never NaN; no "saves ... versus the minimum" claim.
//   card 'y': same, with a known $25 payment plus an unknown one -> the $25
//     is shown as an incomplete minimum, and no saving is claimed against it.
//   renewal: $300,000 mortgage paid $1,000 bi-weekly; HELOC $100,000 with a
//     cash payment of unknown amount -> today's HELOC and household cash are
//     unknown (null, printed "unknown"), the keep-separate payment is
//     incomplete (printed Unknown), the comparison is withheld.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast.js');

const card = id => ({ id, label: 'Invented card ' + id, balance: 1000, pending: 0, rate: 20, rateConvention: 'card' });
const pay = (id, debtId, amount) => ({ id, debtId, effect: 'payment', frequency: 'monthly', day: 5, amount, confidence: 'confirmed' });

for (const unknown of [null, undefined, '', 'n/a']) {
  const label = JSON.stringify(unknown) || 'undefined';
  const [x] = F.payoffDebts({ obligations: [pay('x-min', 'x', unknown)] }, [card('x')]);
  assert.equal(x.minimumId, 'unknown', `${label}: an unknown-amount payment is an unknown minimum, never "none"`);
  assert.deepEqual(x.unmodelled, ['x-min'], `${label}: the payment is named as having no monthly amount`);
  assert.ok(!Number.isNaN(x.minimum), `${label}: the minimum is never NaN`);
  assert.equal(x.minimumConfidence, null, `${label}: an unknown payment lends the minimum no confidence`);
  assert.ok(!x.presets.some(p => p.id === 'minimum'), `${label}: no "minimum" preset is offered`);
  assert.equal(F.payoffModel(x, 200).versusMinimum, null, `${label}: no saving is claimed against an unknown minimum`);

  const [y] = F.payoffDebts({ obligations: [pay('y-a', 'y', 25), pay('y-b', 'y', unknown)] }, [card('y')]);
  assert.equal(y.minimumId, 'cash');
  assert.equal(y.minimum, 25, `${label}: the known $25 is shown, as an incomplete minimum`);
  assert.deepEqual(y.unmodelled, ['y-b']);
  assert.ok(!y.presets.some(p => p.id === 'minimum'), `${label}: an incomplete minimum is not offered as a preset`);
  assert.equal(F.payoffModel(y, 200).versusMinimum, null, `${label}: no saving is claimed against an incomplete minimum`);
}
// Control: a complete minimum keeps its preset and its comparison.
const [z] = F.payoffDebts({ obligations: [pay('z-min', 'z', 25)] }, [card('z')]);
assert.equal(z.minimumId, 'cash');
assert.equal(z.minimum, 25);
assert.ok(z.presets.some(p => p.id === 'minimum' && p.amount === 25));
assert.ok(F.payoffModel(z, 200).versusMinimum, 'a complete minimum still supports the saving line');

// Renewal.
const DEBTS = [
  { id: 'mortgage', label: 'Mortgage', secured: true, balance: 300000, pending: 0, rate: 6, interestTreatment: 'paid-in-payment' },
  { id: 'heloc', label: 'HELOC', secured: true, balance: 100000, pending: 0, rate: 6, limit: 120000,
    interestTreatment: 'paid-in-payment', cashPayment: 500, monthlyInterest: 500 },
];
const plan = helocAmount => ({ obligations: [
  { id: 'mortgage', debtId: 'mortgage', effect: 'payment', frequency: 'biweekly', anchor: '2026-08-14', amount: 1000 },
  { id: 'heloc', debtId: 'heloc', effect: 'payment', frequency: 'monthly', day: 31, amount: helocAmount },
] });
const r = F.renewal(plan(null), DEBTS, { rate: 6, years: 10, consolidate: false, basis: 'variable' });
assert.equal(r.today.helocCash, null, 'an unknown HELOC payment is unknown today cash, never $0');
assert.equal(r.today.householdCash, null, 'household cash today is unknown');
assert.ok(Math.abs(r.today.mortgageCash - 26000 / 12) < 0.01, 'the known mortgage leg is unchanged: $1,000 x 26 / 12');
assert.equal(r.paymentComplete, false, 'the keep-separate payment is incomplete');
assert.equal(r.direction, 'unknown', 'the comparison is withheld');
assert.equal(r.delta, null);
const ok = F.renewal(plan(500), DEBTS, { rate: 6, years: 10, consolidate: false, basis: 'variable' });
assert.equal(ok.paymentComplete, true);
assert.ok(Math.abs(ok.today.householdCash - (26000 / 12 + 500)) < 0.01, 'control: a known HELOC payment counts');
const consolidated = F.renewal(plan(null), DEBTS, { rate: 6, years: 10, consolidate: true, basis: 'variable' });
assert.equal(consolidated.paymentComplete, true, 'consolidating prices a new loan, so its payment stays complete');
assert.equal(consolidated.direction, 'unknown', 'but today is still incomplete, so no comparison');

// The page prints those unknowns as words, never $0 / $NaN.
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('public/app.js'), mod = read('public/modellers.js');
const grab = (src, re) => { const m = re.exec(src); assert.ok(m, 'missing ' + re); return m[0]; };
const maps = vm.runInNewContext([
  grab(app, /^const money = .*$/m), grab(app, /^const money2 = .*$/m),
  grab(mod, /^const PAYOFF_MINIMUM_CONFIDENCE = \{[\s\S]*?^\};$/m),
  grab(mod, /^const PAYOFF_MINIMUM_NOTE = \{[\s\S]*?^\};$/m),
  grab(mod, /^const PAYOFF_MINIMUM_GAP = [\s\S]*?;$/m),
  grab(mod, /^const renewalCash = .*$/m),
  grab(mod, /^const RENEWAL_CONTEXT = \{[\s\S]*?^\};$/m),
  '({ PAYOFF_MINIMUM_NOTE, PAYOFF_MINIMUM_GAP, RENEWAL_CONTEXT })',
].join('\n'));
const [x] = F.payoffDebts({ obligations: [pay('x-min', 'x', null)] }, [card('x')]);
const payoffText = maps.PAYOFF_MINIMUM_NOTE[x.minimumId](x) + maps.PAYOFF_MINIMUM_GAP(x);
assert.match(payoffText, /minimum is unknown/);
assert.doesNotMatch(payoffText, /\$0|NaN|no minimum/, 'payoff never says $0 or "no minimum" for an unknown payment');
const context = maps.RENEWAL_CONTEXT[r.today.id](r);
assert.match(context, /unknown/);
assert.doesNotMatch(context, /\$0\b|NaN/, 'renewal today never prints $0 or NaN for an unknown payment');
assert.match(mod, /r\.paymentComplete === false \? 'Unknown'/, 'the renewal payment prints Unknown when incomplete');
console.log('unknown payoff / renewal payments never print as $0 or NaN: ok');
