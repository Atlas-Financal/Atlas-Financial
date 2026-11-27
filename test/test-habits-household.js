'use strict';

// First slice of the invented habits household. Exercise the same ledger across
// four refreshes through the observer and Forecast. Expected amounts come from
// the ledger below, independently of the implementation's totals.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = fs.readFileSync;
fs.readFileSync = function (file, ...options) {
  if (typeof file === 'string') {
    const relative = path.relative(root, path.resolve(file)).split(path.sep).join('/').toLowerCase();
    if (relative === 'public/periods.json') return '{"monthly":[]}';
    if (relative === 'data.json' || /^(snapshots|raw|derived)\//.test(relative)) {
      throw new Error('Habits test requires invented data');
    }
  }
  return read.call(this, file, ...options);
};

try {
  const { world } = require('./fixtures/card-coverage-aggregate-world');
  const Forecast = require('../public/forecast');
  const Live = require('../scripts/live-plan');
  const charges = [
    ['card', 80, '2026-09-19', 'purchase', { id: 81001 }],
    ['card', 37, '2026-09-20', 'purchase', { id: 81002, is_pending: true }],
    ['card', 37, '2026-09-21', 'purchase', { id: 81003, pending_transaction_id: 81002 }],
    ['card', 52, '2026-10-03', 'purchase', { id: 81004 }],
    ['card', 31, '2026-10-18', 'purchase', { id: 81005 }],
  ];
  const views = [
    { date: '2026-09-20', start: '2026-09-18', spent: 117, posted: 480 },
    { date: '2026-09-21', start: '2026-09-18', spent: 117, posted: 517 },
    { date: '2026-10-03', start: '2026-10-02', spent: 52, posted: 569 },
    { date: '2026-10-18', start: '2026-10-16', spent: 31, posted: 600 },
  ];

  function observe(day, rows, change = () => {}) {
    const input = world(rows, {
      asOf: day,
      edit(candidate) {
        candidate.identity = { rules: [], billPaymentPayees: [] };
        const posted = rows.filter(row => row[0] === 'card' && row[4]?.is_pending !== true);
        candidate.payload.accounts[3].balance = 400 + posted.reduce((sum, row) => sum + row[1], 0);
        candidate.payload.accounts[3].last_fetch = day + 'T17:00:00Z';
        change(candidate);
      },
    });
    const observed = Live.fromObservation(input).data;
    const advice = Forecast.recommend(observed.plan, day, Forecast.budgetRecommendInputs(observed));
    return {
      observed,
      period: advice.payPeriodViews.find(view => view.role === 'active'),
      coverage: advice.cardPurchaseCoverage,
    };
  }

  function spent(result) {
    return result.period.stackSummary.credit.lines.find(line => line.id === 'travelvisa').spent.amount;
  }

  for (const view of views) {
    const rows = charges.filter(row => row[2] <= view.date);
    const result = observe(view.date, rows);
    assert.equal(result.period.start, view.start, view.date + ' uses its own pay period');
    assert.equal(result.observed.debts[0].balance, view.posted, view.date + ' observes posted balance');
    assert.equal(spent(result), view.spent, view.date + ' counts one charge across pending and settlement');
    assert.equal(result.period.householdBudget.find(row => row.id === 'groceries').spent, view.spent,
      view.date + ' reconciles independent groceries and card totals');
  }

  // Break only the card's issuer sync in a cold observation. Keep the Bills
  // balance and the fresh independent cash purchase in the live publication.
  const cashPurchase = ['bills', 12, '2026-09-20', 'purchase', { id: 81006 }];
  const sameDay = charges.slice(0, 2);
  const paidFromBills = observe('2026-09-20', [...sameDay, cashPurchase]);
  const thinCard = observe('2026-09-20', [...sameDay, cashPurchase], input => {
    delete input.payload.accounts[3].last_fetch;
  });
  assert.equal(spent(paidFromBills), 117);
  assert.equal(spent(thinCard), null, 'a cold card without issuer sync withholds card Spent');
  assert.equal(thinCard.period.liveCurrentBalance, 488, 'independent posted Bills cash stays fresh');
  assert.equal(thinCard.period.householdBudget.find(row => row.id === 'groceries').spent, 129,
    'independent budget spending includes the fresh Bills purchase');

  // The Bills shortfall split follows #1676. A clean card ledger can currently
  // be withheld by a known negative Bills balance. When that fix lands, turn
  // this characterization into the positive independent-publication assertion.
  const noCharges = observe('2026-09-20', []);
  const shortfall = observe('2026-09-20', [], input => {
    input.payload.accounts[0].balance = -4;
  });
  assert.equal(noCharges.coverage.status, 'ready');
  assert.equal(shortfall.period.liveCurrentBalance, -4, 'known bank balance survives');
  assert(shortfall.coverage.issues.some(issue => issue.code === 'coverage-bills-backing-unconfirmed'),
    'Known gap: split a known Bills shortfall from unreadable backing evidence');

  console.log('Habits household: four dates, a cold issuer-sync fault, and the known Bills shortfall gap passed.');
} finally {
  fs.readFileSync = read;
}
