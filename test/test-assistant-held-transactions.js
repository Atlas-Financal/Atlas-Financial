'use strict';
/* The assistant packet lists the held current-period transactions behind
 * unclassified.count, so the morning Lunch Money sort can clear them, and it
 * lists nothing else about them (lead dispatch, 2026-11-17).
 *
 * Invented data only (test/fixtures/savings-daily-consumer-data). The planted
 * payee, bank description, note, amount and category id stand in for what a
 * real row carries; none may reach the packet.
 *
 *   node test/test-assistant-held-transactions.js
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Assistant = require('../scripts/assistant-packet');
const Forecast = require('../public/forecast');
const fixture = require('./fixtures/savings-daily-consumer-data');

const ROOT = path.join(__dirname, '..');
let checks = 0;
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
const ok = (c, label) => { assert.ok(c, label); checks++; };

const PLANTED = { payee: 'PLANTED PAYEE ZQX', bank: 'PLANTED BANK DESC QJW', note: 'PLANTED NOTE VKP',
  amount: 47.31, categoryId: 9876543 };
function held(id, date, extra) {
  return Object.assign({ id, date, amount: PLANTED.amount, pending: false, atlasAccountId: 'chequing-a',
    accountRole: 'household-cash', currency: 'CAD', savingsPostingEvidence: 'posted',
    displayedPayee: PLANTED.payee, payee: PLANTED.payee, originalName: PLANTED.bank, notes: PLANTED.note,
    categoryId: PLANTED.categoryId, categoryLabel: 'Mystery Bucket' }, extra);
}
function served(rows) {
  const d = fixture();
  d.liveOverlay.currentPeriodActuals.transactions.push(...rows);
  return d;
}
const build = data => Assistant.buildPacket({ data, periods: { periods: {} }, questionsMarkdown: '',
  env: {}, now: '2026-10-05T12:00:00Z' });
const heldOf = packet => packet.uncertainty.incompleteCategoryCoverage.heldCurrentPeriod;

// 1. Positive: each held row is listed with date, role, budget row, reason
// class, one fixed sentence and its place among same-date, same-role rows.
const data = served([
  held('tx-held-a', '2026-10-04'),
  held('tx-held-b', '2026-10-04'),
  held('tx-held-c', '2026-10-03', { categoryLabel: null, categoryId: null }),
]);
const packet = build(data);
const list = heldOf(packet);
const advice = Forecast.recommend(data.plan, Forecast.budgetAsOf(data), Forecast.budgetRecommendInputs(data, {}));
eq(list.status, 'ok', 'the list is published');
eq(list.count, advice.currentPeriodAction.unclassified.count, 'the list counts exactly the page\'s unclassified rows');
eq(list.listed, list.count, 'every held row is listed');
eq(list.complete, true, 'the list is complete');
ok(list.count >= 3, 'the three invented held rows are among them');
for (const item of list.items) {
  eq(Object.keys(item).sort(), ['accountRole', 'budgetRow', 'date', 'key', 'ordinal', 'reason', 'reasonClass'],
    item.key + ': a closed set of fields');
  ok(/^held-\d+$/.test(item.key), item.key + ': a packet-local key, not a transaction id');
  const allowed = Object.values(Assistant.HELD_REASONS).concat([['other', 'Atlas could not place it in a budget row.'],
    ['category', 'It is filed as uncategorised.']]);
  ok(allowed.some(([cls, text]) => cls === item.reasonClass && text === item.reason), item.key + ': a fixed reason sentence');
}
const onThe4th = list.items.filter(i => i.date === '2026-10-04' && i.accountRole === 'household-cash');
eq(onThe4th.map(i => i.ordinal), [{ n: 1, of: 2 }, { n: 2, of: 2 }], 'two rows on one date and account read 1 of 2, 2 of 2');
eq(onThe4th.map(i => i.reason), Array(2).fill(Assistant.HELD_REASONS['unmapped-label'][1]),
  'an unmatched Lunch Money category reads its fixed sentence');
const noCategory = list.items.find(i => i.date === '2026-10-03');
eq(noCategory.reason, Assistant.HELD_REASONS['no-category'][1], 'a row with no category reads its fixed sentence');
eq(noCategory.ordinal, { n: 1, of: 1 }, 'a lone row reads 1 of 1');

// 2. Negative: no amount, payee, bank description, note, raw category or
// transaction id, or raw reason code reaches the packet.
const blob = JSON.stringify(packet);
for (const [what, value] of Object.entries(PLANTED)) ok(!blob.includes(String(value)), 'no planted ' + what + ' in the packet');
for (const id of ['tx-held-a', 'tx-held-b', 'tx-held-c']) ok(!blob.includes(id), 'no transaction id ' + id + ' in the packet');
const listBlob = JSON.stringify(list);
for (const code of Object.keys(Assistant.HELD_REASONS)) ok(!listBlob.includes('"' + code + '"'), 'no raw reason code ' + code);
ok(Assistant.looksSanitized(packet), 'the packet still passes its sanitization check');

// 3. The projection closes every field: an unknown reason, a forged role and
// a budget row outside the plan read as fixed defaults, never passed through.
const forged = Assistant.heldCurrentPeriodProjection({ plan: { budget: { categories: [{ id: 'groceries' }] } } },
  { currentPeriodAction: { unclassified: { count: 2 }, heldTransactions: [
    { id: 'x', date: '2026-10-04', accountRole: 'PLANTED ROLE', kind: 'unclassified', reason: 'PLANTED-CODE', budgetRow: 'PLANTED ROW' },
    { id: 'y', date: 'not-a-date', accountRole: 'household-cash', kind: 'unclassified', reason: null, budgetRow: 'groceries' },
  ] } });
eq(forged.items.map(i => [i.accountRole, i.budgetRow, i.reasonClass]), [[null, null, 'other'], ['household-cash', 'groceries', 'other']],
  'unknown role, row and reason read as null and the default class');
eq(forged.items[1].date, null, 'a malformed date reads null');
ok(!JSON.stringify(forged).includes('PLANTED'), 'nothing forged passes through');
const many = Assistant.heldCurrentPeriodProjection({ plan: {} }, { currentPeriodAction: { unclassified: { count: 60 },
  heldTransactions: Array.from({ length: 60 }, (_, i) => ({ id: 'z' + i, date: '2026-10-04', accountRole: 'household-cash', reason: 'no-category' })) } });
eq([many.count, many.listed, many.complete], [60, 50, false], 'at most fifty rows are listed, and the list says it is incomplete');
eq(Assistant.heldCurrentPeriodProjection({}, { currentPeriodAction: {} }).status, 'unavailable', 'no list is unavailable, never empty-and-ok');

// 4. Nothing reaches the page or the figures snapshot: only the packet asks.
const pageAdvice = Forecast.recommend(data.plan, Forecast.budgetAsOf(data), Forecast.budgetRecommendInputs(data, {}));
ok(!('heldTransactions' in pageAdvice.currentPeriodAction), 'Forecast publishes no held list unless asked');
for (const file of ['public/plan.js', 'public/app.js', 'public/budget-surface.js', 'scripts/figures-snapshot.js', 'server.js']) {
  ok(!fs.readFileSync(path.join(ROOT, file), 'utf8').includes('collectHeldTransactions'), file + ' never asks for the held list');
}

console.log(`test-assistant-held-transactions: ${checks} checks passed`);
