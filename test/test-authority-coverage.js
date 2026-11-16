'use strict';
/* Mechanical coverage guard for the named financial-authority surfaces.
 *
 * This deliberately does NOT claim to discover every place financial authority
 * could ever appear. B75 established that such a claim would itself be a false
 * green. Instead, this guard covers the mechanically enumerable surfaces the
 * repository has already named:
 *
 *   1. Forecast exports — every export must be either an explicitly classified
 *      non-authority helper or named in ARCHITECTURE.md's incumbent table.
 *   2. data.json plan policy keys — actions, nextDollar, decisionPosture, payrollPlanningAssumptions and budget.
 *   3. the calculators that used to live in public/app.js, the shared page core:
 *      each must be defined in the engine and absent from the page.
 *   4. the named artifact-writing scripts already named as financial
 *      authorities: periods.js, calendar-ics.js, snapshot-balances.js.
 *   5. the named read-only assistant projection: assistant-packet.js.
 *
 * Page scripts that decide rather than render remain the B73 review class because
 * there is no closed mechanical signature for them. This guard does not pretend
 * otherwise.
 */

const fs = require('fs');
const path = require('path');
const data = require('../data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const architecture = read('ARCHITECTURE.md');
const tableStart = architecture.indexOf('| Concept | Incumbent authority |');
const tableEnd = architecture.indexOf('**The table is not a closed list', tableStart);
const incumbentTable = tableStart >= 0 && tableEnd > tableStart
  ? architecture.slice(tableStart, tableEnd)
  : '';

ok(!!incumbentTable,
  'ARCHITECTURE.md contains the incumbent financial-authority table');

const FORECAST_NON_AUTHORITY = new Set([
  'HOUSEHOLD_TIMEZONE',
  'financialDate',
  'addDays',
  'diffDays',
  'occurrences',
  'commitmentSettledOn',
  'commitmentSettledBy',
  'commitmentStatus',
  'commitmentNeed',
  'viewRange',
  'billIsHouseholdObligation',
  'billAffectsJointCash',
  'recommendWeekly',
  'publishedSpendType',
  'rollupSpending',
  'EPSILON',
  'STEP',
  'startingCashAmount',
  'postedHouseholdChequingCash',
  'resolveFundingSources',
  'resolveActions',
]);

function forecastExportsFrom(source) {
  const block = /const Forecast\s*=\s*\{([\s\S]*?)\};\s*if \(typeof module/.exec(source);
  if (!block) return null;
  return block[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => {
      const m = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(x);
      return m ? m[1] : null;
    })
    .filter(Boolean);
}

function forecastCoverageProblems(source, table) {
  const exports = forecastExportsFrom(source);
  if (!exports) return ['<unreadable-export-object>'];
  return exports.filter(name =>
    !FORECAST_NON_AUTHORITY.has(name)
    && !new RegExp(`Forecast\\.${name}\\b`).test(table));
}

console.log('\n=== Forecast export coverage ===');
const forecastSource = read('public/forecast.js');
const forecastExports = forecastExportsFrom(forecastSource);
ok(!!forecastExports, 'Forecast export object is mechanically readable');

for (const name of forecastExports || []) {
  if (FORECAST_NON_AUTHORITY.has(name)) {
    ok(true, `Forecast.${name} is explicitly classified as a non-authority helper`);
    continue;
  }
  ok(new RegExp(`Forecast\\.${name}\\b`).test(incumbentTable),
    `Forecast.${name} is named in the incumbent authority table`);
}

ok((forecastExports || []).length > 0,
  'Forecast export enumeration found at least one export',
  (forecastExports || []).join(', '));

console.log('\n=== guard bite proof ===');
// EVERY mention, not just the first. The guard's predicate is "is this export
// named in the table at all", so removing one of two mentions does not model
// the violation — and `Forecast.recommend` is now named twice, once for the
// weekly cap and once for the funding result the per-source verdicts come from.
// Replacing only the first left a surviving mention and the guard, correctly,
// did not fire.
const withoutRecommend = incumbentTable.replace(/Forecast\.recommend\b/g, 'Forecast.REMOVED_recommend');
const missingRowProblems = forecastCoverageProblems(forecastSource, withoutRecommend);
ok(missingRowProblems.includes('recommend'),
  'removing an incumbent Forecast row makes the guard fail',
  missingRowProblems.join(', '));

const withNewExport = forecastSource.replace(/const Forecast\s*=\s*\{/,
  'const Forecast = { newFinancialAuthority,');
const newExportProblems = forecastCoverageProblems(withNewExport, incumbentTable);
ok(newExportProblems.includes('newFinancialAuthority'),
  'adding a new Forecast export without an authority row makes the guard fail',
  newExportProblems.join(', '));

// The page-core check has to bite on a REINSTATED calculator, not only on the
// absence of one — an assertion that nothing is there passes trivially while it
// is looking in the wrong place.
const pageCalculatorReturns = src => {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return /function\s+payoff\s*\(/.test(code) || /(const|let|var)\s+monthlyRate\s*=/.test(code);
};
ok(pageCalculatorReturns(read('public/app.js')
  + '\nconst monthlyRate = annualPct => (annualPct / 100) * 30 / 365;\n'),
'putting a payoff rate back into the page core makes the guard fail');
ok(!pageCalculatorReturns(read('public/app.js')),
  'and the real page core does not trip it');

console.log('\n=== data.json plan policy coverage ===');
for (const key of ['actions', 'nextDollar', 'decisionPosture', 'payrollPlanningAssumptions', 'budget']) {
  ok(Object.prototype.hasOwnProperty.call(data.plan || {}, key),
    `data.json plan.${key} exists`);
  ok(new RegExp(`plan\\.${key}\\b`).test(incumbentTable),
    `plan.${key} is named in the incumbent authority table`);
}

console.log('\n=== public/app.js calculator coverage ===');
// The payoff and renewal calculators that once lived in the shared page core
// have been retired from the engine altogether, so no live calculator of theirs
// remains anywhere.
//
// This checks they did not come BACK. `public/app.js` is loaded by all four
// pages, so a calculation reinstated here reaches the household from every one
// of them at once and no suite can reach it from any of them. The names are
// checked as definitions, not mentions, so a comment explaining why they left
// does not read as their return.
const appSource = read('public/app.js');
const appCode = appSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
for (const fn of ['payoff', 'monthlyRate', 'amortisedPayment']) {
  ok(!new RegExp(`function\\s+${fn}\\s*\\(`).test(appCode)
    && !new RegExp(`(const|let|var)\\s+${fn}\\s*=`).test(appCode),
  `${fn}() is not a page-core calculator`);
}

console.log('\n=== artifact-writer coverage ===');
for (const script of ['scripts/periods.js', 'scripts/calendar-ics.js', 'scripts/snapshot-balances.js']) {
  ok(fs.existsSync(path.join(__dirname, '..', script)), `${script} exists`);
  const short = path.basename(script);
  ok(incumbentTable.includes(script) || incumbentTable.includes(short),
    `${script} is named in the incumbent authority table`);
}

console.log('\n=== read-only assistant projection coverage ===');
{
  const script = 'scripts/assistant-packet.js';
  ok(fs.existsSync(path.join(__dirname, '..', script)), `${script} exists`);
  ok(incumbentTable.includes(script) || incumbentTable.includes('assistant-packet.js'),
    `${script} is named in the incumbent authority table`);
  const src = read(script);
  ok(!/writeFileSync|writeFile\(/.test(src),
    'assistant-packet.js does not write files');
}

console.log('\n=== hard-gate protection ===');
const mergeCard = read('.github/workflows/merge-card-check.yml');
ok(/authority-coverage/.test(mergeCard),
  'changing this guard is mechanically high-risk and cannot claim NOT REQUIRED');

console.log('\n=== declared coverage boundary ===');
ok(/Page scripts that decide rather than render remain the B73 review class/.test(
  fs.readFileSync(__filename, 'utf8')),
  'the guard states its non-mechanical B73 boundary rather than claiming completeness');

console.log('\n' + '═'.repeat(60));
if (failures) {
  console.log(`FAILED — ${failures} authority coverage check(s)`);
  process.exit(1);
}
console.log('ALL NAMED AUTHORITY SURFACES ARE MECHANICALLY COVERED');
