'use strict';

const assert = require('node:assert/strict');
const fc = require('fast-check');
const { makeHousehold } = require('./households');
const { expectedCash } = require('./cash-card');
const { observedCash } = require('./observed-cash');

function checkLeapHorizon(seed) {
  const amounts = fc.record({
    cash: fc.integer({ min: -5000, max: 5000 }),
    pay: fc.integer({ min: 1, max: 5000 }),
    dailyAllowanceCents: fc.integer({ min: 1, max: 20 }),
  });
  fc.assert(fc.property(amounts, input => {
    for (const horizonDays of [366, 367]) {
      const facts = makeHousehold({
        cash: input.cash, pay: input.pay, weeklyAllowanceCents: 7 * input.dailyAllowanceCents,
        payday: '2027-03-01', elapsed: 0, horizonDays,
        semiMonthlyOnly: false, secondPay: null, weeklyCash: 0, groceries: 0,
        bills: [], purchases: [], mortgage: null, card: null, heloc: null,
      });
      facts.opts.daleIncomeAuthorityEnd = '2028-03-31';
      const observed = observedCash(facts);
      assert.deepEqual(observed, expectedCash(facts));
      assert.equal(observed.daily.length, horizonDays);
      assert.equal(observed.daily[365].date, '2028-02-29');
      // This walk starts on payday. The opening and both possible closings
      // can be reconciled directly without using a simulated daily balance.
      const payCount = 1 + Math.floor((horizonDays - 1) / 14);
      const closing = input.cash + payCount * input.pay - horizonDays * input.dailyAllowanceCents;
      assert.equal(observed.endingCents, closing);
    }
  }), { seed, numRuns: 8 });
}

module.exports = { checkLeapHorizon };
