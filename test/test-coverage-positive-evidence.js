'use strict';
/* A1 / A2 — the transactionCoverage stamp reads 'complete' only on positive
 * evidence (Astra audit, #787 comment 6684193703).
 *
 * Invented rows only. Each case removes one piece of evidence from an
 * otherwise fully evidenced Lunch Money payload, runs the real observer, and
 * hands its packet to Forecast, the path the household reads. Every gap must
 * stamp the packet 'incomplete' and leave the dependent current figures
 * withheld (claim unavailable, current remainder Unknown). The fully evidenced
 * control must stay 'complete' with numeric figures.
 *
 * `node test/test-coverage-positive-evidence.js`
 */
const fs = require('fs');
const O = require('../scripts/provider-observe.js');
const F = require('../public/forecast.js');
const fx = require('./fixtures/budget-surface-data');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const identity = JSON.parse(fs.readFileSync(O.DEFAULT_IDENTITY, 'utf8'));
const clone = x => JSON.parse(JSON.stringify(x));

function run(mutate) {
  const payload = fx.payload();
  const accountMap = { ...clone(fx.map), scope: 'live' };
  if (mutate) mutate(payload, accountMap);
  const pk = O.observe({ provider: 'lunchmoney', data: fx.canonical(), payload, accountMap, identity })
    .currentPeriodActuals;
  const served = fx.served();
  const advice = F.recommend(served.plan, served.meta.asOf,
    { debts: served.debts, weeklyVariable: 0, ...served.liveOverlay, currentPeriodActuals: pk });
  const cur = advice.payPeriodViews.find(v => v.timelineRole === 'current');
  return { pk, claim: advice.currentPeriodAction.remainingClaim, remainder: cur ? cur.balanceAfterDeductions : undefined };
}

function expectWithheld(label, mutate) {
  const r = run(mutate);
  ok(r.pk.transactionCoverage === 'incomplete', `${label}: stamp incomplete`, r.pk.transactionCoverage);
  ok(r.claim === 'unavailable' && r.remainder === null,
    `${label}: Forecast withholds the claim and the current remainder is Unknown`, JSON.stringify([r.claim, r.remainder]));
}

console.log('=== 0. control: a fully evidenced payload stays complete with numeric figures ===');
{
  const r = run();
  ok(r.pk.transactionCoverage === 'complete', 'stamp complete', r.pk.transactionCoverage);
  ok(r.claim !== 'unavailable' && typeof r.remainder === 'number' && Number.isFinite(r.remainder),
    'Forecast publishes a claim and a numeric current remainder', JSON.stringify([r.claim, r.remainder]));
  const split = run(p => p.transactions.push(
    { ...p.transactions[2], id: 92100, amount: 100, is_group: true },
    { ...p.transactions[2], id: 92101, amount: 60, parent_id: 92100 },
    { ...p.transactions[2], id: 92102, amount: 40, parent_id: 92100 }));
  ok(split.pk.transactionCoverage === 'complete' && typeof split.remainder === 'number',
    'a split whose children sum to the parent to the cent stays complete', split.pk.transactionCoverage);
}

console.log('\n=== 1. no affirmative complete === true on the window ===');
expectWithheld('window complete absent', p => { delete p.transactionWindow.complete; });
expectWithheld('window complete is a truthy non-boolean', p => { p.transactionWindow.complete = 'yes'; });

console.log('\n=== 2. the transactions collection is missing (not merely empty) ===');
expectWithheld('transactions collection missing', p => { delete p.transactions; });
{
  // Present and empty is evidence of no rows; it does not trip this rule.
  const r = run(p => { p.transactions = []; });
  ok(r.pk.transactionCoverage === 'complete', 'a present, empty collection is not treated as missing', r.pk.transactionCoverage);
}

console.log('\n=== 3. no mapped Bills account ===');
expectWithheld('Bills account not mapped', (p, map) => {
  map.mappings = map.mappings.filter(m => m.canonical.id !== 'chequing-a');
  p.transactions = p.transactions.filter(t => t.account_id !== 1001);
  p.accounts = p.accounts.filter(a => a.id !== 1001);
});

console.log('\n=== 4. the source window has no start or end ===');
expectWithheld('window start missing', p => { delete p.transactionWindow.startDate; });
expectWithheld('window end missing', p => { delete p.transactionWindow.endDate; });

console.log('\n=== 5. a household row carries no pending state ===');
expectWithheld('household-cash row without is_pending', p => { delete p.transactions[3].is_pending; });
expectWithheld('household-cash row with a non-boolean is_pending', p => { p.transactions[3].is_pending = 'false'; });

console.log('\n=== 6. a household cash row in a non-CAD currency with no conversion evidence ===');
expectWithheld('household-cash row in USD', p => { p.transactions[3].currency = 'usd'; });
expectWithheld('household-cash row with no currency', p => { delete p.transactions[3].currency; });

console.log('\n=== 7. (A2) a split whose present children do not reconcile to the parent ===');
expectWithheld('children sum short of the parent', p => p.transactions.push(
  { ...p.transactions[2], id: 92100, amount: 100, is_group: true },
  { ...p.transactions[2], id: 92101, amount: 30, parent_id: 92100 },
  { ...p.transactions[2], id: 92102, amount: 50, parent_id: 92100 }));
expectWithheld('children off by one cent', p => p.transactions.push(
  { ...p.transactions[2], id: 92100, amount: 100, is_group: true },
  { ...p.transactions[2], id: 92101, amount: 60, parent_id: 92100 },
  { ...p.transactions[2], id: 92102, amount: 39.99, parent_id: 92100 }));

console.log('\n' + (failures ? `${failures} failure(s)` : 'ALL CHECKS PASSED'));
process.exit(failures === 0 ? 0 : 1);
