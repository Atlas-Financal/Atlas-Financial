const fs = require('fs');
const Module = require('module');
const path = require('path');
const forecastPath = path.resolve('public/forecast.js');
const testPath = path.resolve('test/test-road-ahead-reconciliation.js');
const original = fs.readFileSync(forecastPath, 'utf8');
const tests = fs.readFileSync(testPath, 'utf8');
const cases = [
  ['independent span rounding', /const householdBudgetAmount = roundCent\(\s*trajectoryVariableThrough\(weekly, priorWalkDays \+ walkDays\)\s*- trajectoryVariableThrough\(weekly, priorWalkDays\)\);/, 'const householdBudgetAmount = roundCent(weekly * walkDays / 7);'],
  ['omit bills', 'const billsAmount = sumOut(bills);', 'const billsAmount = 0;'],
  ['duplicate required debt', 'const obligationsAmount = sumOut(obligations);', 'const obligationsAmount = 2 * sumOut(obligations);'],
  ['shift dated events', /const apply = cashWalkDate\(e, walkStart\);\r?\n      return apply >= span.start/, 'const apply = addDays(cashWalkDate(e, walkStart), 1);\n      return apply >= span.start'],
  ['promote estimated trust', 'const billsStatus = trajectoryEventsStatus(bills);', "const billsStatus = 'calculated';"],
  ['substitute cumulative cash', 'standalonePeriodResult(stage3Amount, stage3Status)', 'standalonePeriodResult(cash.amount, stage3Status)'],
  ['round fractional debt after grouping', 'amount: e.amount < 0 ? -roundCent(-e.amount) : roundCent(e.amount),', 'amount: e.amount,'],
  ['last-category residual at each boundary',
    /const weights = contributing\.map\(c => Math\.round\(Number\(c\.planned\) \* 100\)\);[\s\S]*?amount: residualCents \/ 100,\r?\n          status: 'calculated',\r?\n        \}\);\r?\n      \}/,
    `const through = days => reconcileTrajectoryLineAmounts(contributing.map(c => ({
          label: c.label || c.id || 'Household budget',
          amount: roundCent((Number(c.planned) / WEEKS_PER_MONTH) * days / 7),
          status: 'calculated',
        })), trajectoryVariableThrough(input.weeklyVariable, days));
      const before = through(priorWalkDays);
      const after = through(priorWalkDays + walkDays);
      for (let i = 0; i < after.length; i++) {
        lines.push(Object.assign({}, after[i], {
          amount: roundCent(after[i].amount - before[i].amount),
        }));
      }`],
];
for (const [name, pattern, replacement] of cases) {
  const changed = original.replace(pattern, replacement);
  if (changed === original) throw Error('Mutation did not apply: ' + name);
  const f = new Module(forecastPath, module); f.filename = forecastPath;
  f.paths = Module._nodeModulePaths(path.dirname(forecastPath)); f._compile(changed, forecastPath);
  const t = new Module(testPath, module); t.filename = testPath;
  t.paths = Module._nodeModulePaths(path.dirname(testPath));
  const req = t.require.bind(t);
  t.require = id => id === '../public/forecast' ? f.exports : req(id);
  let failure;
  try { t._compile(tests, testPath); } catch (e) { failure = e; }
  if (!failure || failure.code !== 'ERR_ASSERTION') throw Error('Mutation escaped or failed for wrong reason: ' + name + ' ' + failure);
  console.log('CAUGHT: ' + name + ' — ' + failure.message.split('\n')[0]);
}
