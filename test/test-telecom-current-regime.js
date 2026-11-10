'use strict';
/* Independent proof that forward telecom uses evidenced active services.
 * `node test/test-telecom-current-regime.js`
 *
 * Does NOT use Forecast.budgetBreakdown as the authority for the Bell
 * baseline or the delta. Historical totals are read from periods.json.
 * Shaw is read from plan.bills. The Bell baseline is reconstructed from
 * the June statement lines recorded in ACCOUNT_FACTS / source evidence.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const F = require('../public/forecast.js');
const data = JSON.parse(execFileSync('git', ['show', '28d08a12:data.json'], { encoding: 'utf8' }));
const periods = require('../public/periods.json');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const money = n => Number(n).toFixed(2);

const plan = data.plan;
const asOf = data.meta.asOf;
const facts = sourceText(fs.readFileSync(path.join(__dirname, '..', 'docs/ACCOUNT_FACTS.md'), 'utf8'));
const evidence = sourceText(fs.readFileSync(
  path.join(__dirname, '..', 'docs/source_intake/HOUSEHOLD_EVIDENCE_2026-08-16.md'), 'utf8'));

console.log('=== cleaned historical Telecom totals ===');
const ytd = periods.periods.ytd.spending.find(s => s.label === 'Telecom');
const last = periods.periods.lastMonth.spending.find(s => s.label === 'Telecom');
const all = periods.periods.all.spending.find(s => s.label === 'Telecom');
ok(near(ytd.total, 2149.91) && periods.periods.ytd.months === 8,
  'cleaned YTD Telecom is $2,149.91 over 8 months');
ok(near(all.total, 3916.38) && periods.periods.all.months === 19,
  'cleaned full-history Telecom is $3,916.38 over 19 months');
ok(near(last.total, 328.40),
  'July 2026 Telecom $328.40 is preserved');

console.log('\n=== independent BEFORE historical remainder ===');
const shaw = (plan.bills || []).find(b => b.id === 'shaw');
const historicalAvg = ytd.total / periods.periods.ytd.months;
const beforeRemainder = historicalAvg - shaw.amount;
ok(near(historicalAvg, 268.73875),
  'BEFORE historical monthly assumption is independently $268.74',
  money(historicalAvg));
ok(shaw && near(shaw.amount, 78.4) && shaw.budgetCategory === 'telecom',
  'dated/explicit Shaw is $78.40 once');
ok(near(beforeRemainder, 190.33875),
  'BEFORE stale remainder is independently YTD − Shaw = $190.34',
  money(beforeRemainder));
ok(near(last.total, shaw.amount + 250),
  'July independently equals Shaw + $250 Bell payment, not a second Shaw');

console.log('\n=== independent AFTER active-service requirement ===');
// Statement / CSV lines from the absorbed evidence, not from budgetBreakdown.
ok(/\$70\.00 monthly services/.test(evidence) && /\$25\.80 device payment/.test(evidence)
  && /\$8\.40 taxes/.test(evidence),
  'June statement lines are in the 2026-08-16 evidence pack');
ok(/BYOD Watch SA Ultd Shr 2GB: \$15\.00/.test(evidence)
  && /GST: \$0\.75/.test(evidence) && /BC PST: \$1\.05/.test(evidence),
  'second-account CSV lines are in the 2026-08-16 evidence pack');
const mainBellBaseline = 70 + 25.80 + 8.40;
const secondWatchBaseline = 15 + 0.75 + 1.05;
const undatedBell = mainBellBaseline + secondWatchBaseline;
ok(near(mainBellBaseline, 104.20),
  'independent main June baseline is $70.00 + $25.80 + $8.40 = $104.20',
  money(mainBellBaseline));
ok(near(secondWatchBaseline, 16.80),
  'independent second-watch CSV is $15.00 + $0.75 + $1.05 = $16.80',
  money(secondWatchBaseline));
ok(near(undatedBell, 121.00),
  'independent undated Bell is $104.20 + $16.80 = $121.00',
  money(undatedBell));
ok(/baseline \*\*\$104\.20\/month\*\*/.test(facts)
  && /\$16\.80\/month/.test(facts)
  && /\$104\.20 \+ \$16\.80 = \$121\.00/.test(facts),
  'ACCOUNT_FACTS records both Bell bills and the $121 undated total');
const telusForward = 0;
const afterGross = shaw.amount + undatedBell + telusForward;
const afterRemainder = afterGross - shaw.amount;
ok(near(afterGross, 199.40),
  'AFTER gross is Shaw $78.40 + Bell $121.00 + Telus $0 = $199.40',
  money(afterGross));
ok(near(afterRemainder, 121.00) && near(telusForward, 0),
  'AFTER remainder is Bell $121.00; Telus forward is $0',
  money(afterRemainder));

console.log('\n=== engine follows the independent reconstruction ===');
const opts = {
  scenario: plan.defaults.scenario, incomeOverrides: {}, disabled: [],
  extraDebtMonthly: plan.defaults.extraDebtMonthly || 0,
  targetBuffer: plan.defaults.targetBuffer,
};
opts.fundingSources = (plan.funding || {}).options;
opts.extraFacilities = data.revolvingExtra;
const advice = F.recommend(plan, asOf, opts);
const budget = F.budgetBreakdown(plan, periods, {
  paypalPerMonth: data.paypal ? data.paypal.perMonth : 0,
  weeklyCap: advice.weekly,
  asOf,
});
const telecom = budget.categories.find(c => c.id === 'telecom');
ok(telecom.source === 'current-regime' && near(telecom.current, undatedBell),
  'engine current-regime amount equals the independent undated Bell total');
ok(near(telecom.historical, historicalAvg),
  'engine historical still equals the independent YTD average');
ok(near(telecom.dated, shaw.amount) && telecom.datedItems.length === 1,
  'engine dated is Shaw once');
ok(near(telecom.gross, afterGross) && near(telecom.planned, 0) && near(telecom.reserved, undatedBell),
  'engine gross matches the independent AFTER reconstruction; planned is reserved off the cap; reserved is Bell');

console.log('\n=== exact delta is entirely the telecom correction ===');
// BEFORE figures reproduced on main abcfd0dfd90dee6eea328af8bb518e7953ce0f79
// from periods.json + budgetBreakdown, before current-regime closeout.
const beforeRequired = 4347.076504120879;
const beforeEssential = 3557.007754120879;
const remainderDelta = beforeRemainder - afterRemainder;
ok(near(remainderDelta, 69.33875),
  'independent remainder delta vs cleaned historical is $69.34/month', money(remainderDelta));
ok(near(budget.requiredMonthly, beforeRequired - remainderDelta),
  'AFTER requiredMonthly drops the stale remainder and still includes reserved Bell',
  money(budget.requiredMonthly));
ok(near(budget.essentialMonthly, beforeEssential - remainderDelta),
  'AFTER essentialMonthly drops the same remainder and still includes reserved Bell',
  money(budget.essentialMonthly));
const WEEKS = 365.25 / 12 / 7;
const independentInCapRequired = (beforeRequired - remainderDelta) - undatedBell;
ok(near(budget.requiredMonthly - independentInCapRequired, undatedBell),
  'coverage minus the in-cap remainder is independently the $121 Bell reserve');
ok(advice.weekly === null && advice.sim.scheduledAmounts.status === 'unavailable' && budget.cap === null,
  'unchanged required-undated source facts withhold the cap while monthly telecom derivation stays known');

console.log('\n=== no double-count, no invented cash Bell, no Telus bill ===');
ok(!(plan.bills || []).some(b => /telus/i.test(b.id + ' ' + b.label)),
  'Telus is not a plan.bills row');
ok(!(plan.bills || []).some(b => /bell|watch/i.test(b.id + ' ' + b.label)),
  'Bell / watch are not invented as joint-cash bills');
ok(!near(telecom.planned, 104.20 + 15) && !near(telecom.planned, 121 + 15)
  && !near(telecom.planned, 121 + 78.4) && near(telecom.planned, 0),
  'main-account watch line and Shaw are not added on top of reserved Bell');
ok(!near(telecom.current, 104.20 + 250) && !near(telecom.current, 121 + 250)
  && !near(telecom.current, 356.62),
  'card repayment and the exceptional August bill are not the baseline');
ok(plan.budget.categories.find(c => c.id === 'telecom').currentMonthly === 121,
  'published currentMonthly is $121.00, not $356.62 or $250');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
