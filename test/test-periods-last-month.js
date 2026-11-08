'use strict';
/* "Last month" is the calendar month before the as-of month, on every day
 * of the month. Invented events: 100 of spending in the previous month and
 * 7 in the as-of month. Before the fix, Date month arithmetic rolled
 * Mar 29-31 forward to March (Feb has no 29-31 outside leap years) and
 * May 31 to May, so "last month" was this month and its total was 7.
 *
 * Independent calendar: the expected previous month is computed here from
 * (year, month) integers, not with Date.
 */
const assert = require('node:assert/strict');
const Periods = require('../scripts/periods');
const A = require('../scripts/assistant-packet');
const Live = require('../scripts/live-plan');
const fixture = require('./fixtures/card-purchase-coverage-data');

const pad = n => String(n).padStart(2, '0');
const prev = (y, m) => (m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`);
const daysIn = (y, m) => [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28,
  31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const spend = (month, amount) => ({ month, kind: 'spend', category: 'Groceries', type: 'essential',
  amount, source: 'lunchmoney-cash' });
let checks = 0;
for (const y of [2023, 2024, 2025, 2026, 2100, 2000]) {
  for (let m = 1; m <= 12; m++) {
    const last = prev(y, m);
    for (const d of [1, 28, daysIn(y, m)]) {
      const asOf = `${y}-${pad(m)}-${pad(d)}`;
      const out = Periods.buildPeriods([spend(last, 100), spend(`${y}-${pad(m)}`, 7)], asOf, null);
      assert.equal(out.lastMonth, last, asOf + ' last month');
      assert.equal(out.periods.lastMonth.spendingTotal, 100, asOf + ' last-month total holds only last month');
      assert.equal(out.periods.lastMonth.label, `Last month (${last})`);
      assert.equal(out.thisMonth, `${y}-${pad(m)}`);
      checks += 4;
    }
  }
}
// Leap-year boundaries named explicitly.
for (const [asOf, last] of [['2024-03-29', '2024-02'], ['2024-03-31', '2024-02'], ['2025-03-29', '2025-02'],
  ['2025-03-31', '2025-02'], ['2026-05-31', '2026-04'], ['2026-01-31', '2025-12'], ['2100-03-29', '2100-02']]) {
  assert.equal(Periods.buildPeriods([spend(last, 1)], asOf, null).lastMonth, last, asOf); checks++;
}

// The assistant packet (ChatGPT / Talk) reads this window: on 2026-03-31 it
// must say last month is 2026-02 and total 100, not March's 7.
{
  const x = fixture();
  const data = Live.fromObservation(x).data;
  data.plan.budget.basis = 'lastMonth';
  const periods = Periods.buildPeriods([spend('2026-02', 100), spend('2026-03', 7)], '2026-03-31', null);
  const packet = A.buildPacket({ data, periods, questionsMarkdown: '', now: '2026-09-20T18:00:00Z', env: {} });
  const actuals = packet.actuals;
  assert.equal(actuals.status, 'ok');
  assert.equal(actuals.window.lastMonth, '2026-02');
  assert.equal(actuals.window.basis, 'lastMonth');
  assert.equal(actuals.spendingTotal, 100, 'the assistant is not handed this month as last month');
  checks += 4;
}
console.log(`  PASS  last month is the previous calendar month on every day (${checks} checks)`);
