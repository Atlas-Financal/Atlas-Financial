'use strict';

const assert = require('node:assert/strict');
const H = require('../acceptance/harness');
const { loadStackPage } = require('./budget-page-harness');

// Read the real card and the sheet targeted by its row. The calling suite
// supplies the planned and posted amounts from its own invented observation.
async function stackBillAmounts(world, start, id, due) {
  H.resetCaptures();
  const { data, error } = H.dataOf(world);
  if (error) throw error;
  const page = await loadStackPage({ data });
  assert.equal(page.status(), 'rendered');
  assert.equal(page.selectPeriod(start), start, 'select the period containing the bill');
  assert.deepEqual(page.errors, []);
  const ctx = page.context(), key = id + '@' + due;
  const view = ctx.recommendation.payPeriodViews.find(period => period.start === start);
  const matches = view.bills.filter(row => row.id === id && row.date === due);
  assert.equal(matches.length, 1, 'one occurrence owns the published figures');
  const history = (ctx.recommendation.billHistory?.[id] || []).filter(row => row.occurrence === key && row.date === due);
  assert.equal(history.length, 1, 'one history entry belongs to the same occurrence');

  const card = page.blockHtml('cards').match(/<details\b[^>]*data-stack-card="bills"[\s\S]*?<\/details>/)?.[0];
  assert.ok(card, 'the selected period renders the Bills card');
  const rows = [...card.matchAll(/<li\b[^>]*data-stack-sheet="([^"]+)"[^>]*>[\s\S]*?<\/li>/g)]
    .filter(match => match[1] === 'bill:' + key);
  assert.equal(rows.length, 1, 'one visible row opens the occurrence');
  const name = world.bills.find(bill => bill.id === id).label;
  assert.ok(rows[0][0].includes('>' + name + '</span>'), 'the visible row names this bill');
  const cardAmount = rows[0][0].match(/<span class="sc-a[^"]*"[^>]*>([^<]+)<\/span>/);
  assert.ok(cardAmount, 'the bill row prints its amount');
  const sheet = page.sandbox.StackSheet.html(ctx, rows[0][1]);
  assert.ok(sheet, 'the bill opens its own sheet');
  const headline = sheet.split('<ul class="stack-sheet-hist">')[0];
  assert.ok(headline.includes('>' + name + '</h3>'), 'the sheet names the selected bill');
  const amount = headline.match(/<div class="stack-sheet-big[^"]*">([\s\S]*?)<\/div>/);
  assert.ok(amount, 'the selected bill has a headline amount');
  function paidCheck(html) {
    const labelled = html.includes('aria-label="Paid"');
    assert.equal(html.includes('✓'), labelled, 'the visible Paid check agrees with its accessible label');
    return labelled;
  }
  return {
    bill: matches[0], history: history[0], totals: view.stackSummary.bills, remaining: view.remainingBills,
    cardAmount: cardAmount[1], sheetAmount: amount[1].replace(/<[^>]*>/g, ''),
    cardPaid: paidCheck(rows[0][0]), sheetPaid: paidCheck(headline),
    disclosure: (rows[0][0] + ' ' + headline).replace(/<[^>]*>/g, ' '),
  };
}

module.exports = { stackBillAmounts };
