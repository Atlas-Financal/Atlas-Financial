'use strict';
// A consumed pending hold (Forecast.pendingHoldReleases) leaves the whole plan as if it had never been in the ledger:
// card coverage, the household budget, period actuals and available cash all read the same as the same world without
// the consumed rows. Regression of the #1571 live incident (lead, 2026-11-23): coverage read the consumed legs as
// purchases and credits of unconfirmed purpose (coverage-purchase-purpose-unconfirmed,
// coverage-payment-or-credit-purpose-unconfirmed) and withheld the plan.
// `node test/test-pending-hold-release-plan.js`
//
// Failure it detects: any plan reader (reconcileCardPurchases, sumCategoryActuals, the household budget, available
// cash) that counts or withholds on a consumed leg. Release decision: any failure blocks.
//
// World: test/fixtures/card-coverage-aggregate-world.js (invented numbers only). Bills 500, a 25 card minimum due on
// the as-of, a posted 80 grocery purchase covered by the ruled 105 TFR-TO C/C -> PAYMENT - THANK YOU pair, groceries
// allowance 150. Hand-derived for the control with one real pending 38 grocery charge: the 105 covers the 25 minimum
// and the 80 purchase; the 38 is an uncovered card purchase, so reserve 38; groceries spent 80 + 38 = 118, left 32;
// Bills observed 500 - 105 = 395; available now = 395 - 38 - 32 = 325.
const assert = require('node:assert/strict');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const purchase = ['card', 80, null, 'purchase'];
const cashLeg = a => ['bills', a, null, 'cash', { payee: 'AB123 TFR-TO C/C', original_name: 'AB123 TFR-TO C/C', category_name: 'Transfer' }];
const pay = a => ['card', -a, null, 'credit', { payee: 'PAYMENT - THANK YOU', original_name: 'PAYMENT - THANK YOU', category_name: 'Transfer' }];
const pend = { is_pending: true, status: 'pending', payee: 'Invented warehouse' };
const base = [purchase, cashLeg(105), pay(105)];
const real = ['card', 38, '2026-09-20', 'purchase', pend];
const hold = ['card', 40, '2026-09-19', 'purchase', pend];
const release = ['card', -40, '2026-09-20', 'purchase', pend];
const issues = s => (s.coverage.issues || []).map(i => i.code);
// The plan's readings that matter, compared as one value. Row references differ between worlds (the fixture numbers
// rows in order), so payments compare by their figures, not their references.
const reading = s => JSON.stringify({ status: s.coverage.status, trust: s.coverage.trust, issues: issues(s),
  reservedCash: s.coverage.reservedCash,
  payments: s.coverage.payments.map(p => ({ status: p.status, amount: p.amount, backfill: p.backfill, cardPayment: p.cardPayment,
    minimumPayment: p.minimumPayment, satisfiesMinimum: p.satisfiesMinimum })),
  budget: s.period.householdBudget.map(r => ({ id: r.id, spent: r.spent })),
  availableNow: s.period.fromTodayFunding.availableNow, spendable: s.advice.spendableHouseholdCash,
  action: s.advice.currentPeriodAction && s.advice.currentPeriodAction.status,
  // sumCategoryActuals feeds the current-period action's categories and its shortfall call.
  shortfall: s.advice.currentPeriodAction && s.advice.currentPeriodAction.currentShortfall,
  categories: (s.advice.currentPeriodAction && s.advice.currentPeriodAction.categories || [])
    .map(c => ({ id: c.id, posted: c.posted, pending: c.pending, spent: c.spent, remaining: c.remaining })) });

console.log('1. Control: the real pending charge alone');
const control = run(world([...base, real]));
ok(control.coverage.status === 'ready' && issues(control).length === 0, 'control: coverage ready, no issues', JSON.stringify(issues(control)));
ok(control.coverage.reservedCash === 38, 'control: the uncovered 38 is reserved (hand-figured)', String(control.coverage.reservedCash));
ok(control.period.householdBudget[0].spent === 118, 'control: groceries spent 80 + 38 = 118', String(control.period.householdBudget[0].spent));
ok(control.period.fromTodayFunding.availableNow === 325, 'control: available now 395 - 38 - 32 = 325', String(control.period.fromTodayFunding.availableNow));

console.log('2. (A) A hold and its same-category release beside the real charge: the plan reads as the control');
const paired = run(world([...base, hold, release, real]));
ok(paired.coverage.status === 'ready' && !issues(paired).some(c => /purpose-unconfirmed/.test(c)),
  'coverage is ready: neither leg is an unconfirmed purchase or credit (the live incident)', JSON.stringify(issues(paired)));
ok(reading(paired) === reading(control), 'coverage, budget, available cash and the action equal the control exactly',
  reading(paired) + ' vs ' + reading(control));

// The whole recommendation, not only the readings above: with row ids pinned across the two worlds, every field of
// Forecast.recommend's output is identical except the input transaction list it echoes (planOptions / simOptions).
{
  const pin = (row, id) => [row[0], row[1], row[2], row[3], { ...(row[4] || {}), id }];
  const pinnedBase = base.map((row, i) => pin(row, 910001 + i));
  const pinnedReal = pin(real, 910010), pinnedHold = pin(hold, 910011), pinnedRelease = pin(release, 910012);
  const omit = new Set(['id', 'ref', 'refs', 'coverageRef']);
  const canon = v => Array.isArray(v) ? v.map(canon).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).filter(k => !omit.has(k)).sort().map(k => [k, canon(v[k])])) : v;
  const advice = rows => { const a = JSON.parse(JSON.stringify(run(world(rows)).advice));
    for (const key of ['planOptions', 'simOptions']) if (a[key] && a[key].currentPeriodActuals) delete a[key].currentPeriodActuals.transactions;
    return JSON.stringify(canon(a)); };
  ok(advice([...pinnedBase, pinnedHold, pinnedRelease, pinnedReal]) === advice([...pinnedBase, pinnedReal]),
    'the whole recommendation with a consumed pair equals the recommendation without it (every reader, not a chosen few)');
}

console.log('3. (B) A hold superseded by its posted final: the plan reads as the posted final alone');
const finalPosted = ['card', 38, '2026-09-20', 'purchase', { payee: 'Invented warehouse' }];
const superseded = run(world([...base, hold, finalPosted]));
const finalOnly = run(world([...base, finalPosted]));
ok(superseded.coverage.status === 'ready' && !issues(superseded).some(c => /purpose-unconfirmed/.test(c)), 'coverage is ready',
  JSON.stringify(issues(superseded)));
ok(superseded.advice.currentPeriodAction.currentShortfall === false, 'no current shortfall from a superseded hold');
// The card's provider pending balance still carries the hold until the issuer drops it, so debt-side figures (extra
// debt absorbable) follow that balance, as Dale decided (no change to debt or utilisation). Everything spending-side
// reads as the posted final alone.
ok(reading(superseded) === reading(finalOnly), 'coverage, budget, period actuals, available cash and the action equal the posted final alone',
  reading(superseded) + ' vs ' + reading(finalOnly));

console.log('4. Controls: what is not consumed still counts or withholds as before');
const lone = run(world([...base, hold, real]));
ok(lone.coverage.reservedCash === 78 && lone.period.householdBudget[0].spent === 158,
  'a pending hold with no release still counts and is reserved: 38 + 40 = 78 reserved, 80 + 38 + 40 = 158 spent',
  JSON.stringify({ reserve: lone.coverage.reservedCash, spent: lone.period.householdBudget[0].spent }));
// An unmatched pending card credit (different amount) is not consumed: it stays a ledger row, read exactly as on the
// pre-#1571 base 38ab2415 (coverage ready, no issues there too).
const F = require('../public/forecast');
const unmatchedCredit = ['card', -25, '2026-09-20', 'purchase', { ...pend, category_name: null }];
const unmatched = run(world([...base, hold, real, unmatchedCredit]));
ok(F.pendingHoldReleases(unmatched.packet).legs.size === 0, 'a credit of another amount consumes nothing');
ok(unmatched.coverage.reservedCash === 78 && unmatched.coverage.status === 'ready',
  'so the hold still counts and is reserved beside it (38 + 40 = 78), as on base', JSON.stringify({ r: unmatched.coverage.reservedCash, s: unmatched.coverage.status }));
console.log(`pending hold and release across the plan: ${checks} checks passed`);
