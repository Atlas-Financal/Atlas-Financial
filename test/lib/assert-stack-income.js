'use strict';
const assert = require('node:assert/strict');
const { loadStackPage } = require('./budget-page-harness');

// These fixtures open on payday. Read the amount inside each named waterfall row
// so the right number under a different heading cannot satisfy the assertion.
async function assertStackIncome({ payday, plan, debts, actuals }, amounts, estimatedRows = []) {
  const page = await loadStackPage({ data: {
    meta: { asOf: payday }, accounts: [], revolvingExtra: [], plan, debts,
    liveOverlay: { applied: true, operatingPlan: 'live', currentPeriodActuals: actuals },
  } });
  assert.equal(page.status(), 'rendered', 'Stack rendered the income fixture');
  assert.equal(page.selectedKey(), payday, 'Stack selected the fixture payday');
  const html = page.blockHtml('waterfall');
  for (const [name, amount] of Object.entries(amounts)) {
    const rows = [...html.matchAll(new RegExp('<li\\b[^>]* data-row="' + name + '"[^>]*>([\\s\\S]*?)</li>', 'g'))];
    assert.equal(rows.length, 1, 'one waterfall row for ' + name);
    const cells = [...rows[0][1].matchAll(/<span class="([^"]*\bn\b[^"]*)"[^>]*>([^<]*)<\/span>/g)];
    assert.equal(cells.length, 1, 'one printed amount for ' + name);
    assert.equal(cells[0][2], '$' + amount.toLocaleString('en-CA', { maximumFractionDigits: 0 }),
      name + ' prints the independently expected income');
    assert.equal(cells[0][1].split(/\s+/).includes('stack-est'), estimatedRows.includes(name),
      name + ' shows the expected income trust');
  }
}
module.exports = { assertStackIncome };
