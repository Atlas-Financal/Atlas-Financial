'use strict';

const assert = require('node:assert/strict');

// These invented periods contain one bill or none. A posted payment counts once
// in its own period. A schedule-only amount can be estimated without being paid.
function assertBillPeriod(page, start, bill, { paid, trust }) {
  assert.equal(page.status(), 'rendered');
  assert.equal(page.selectPeriod(start), start, 'selected the requested pay period');
  assert.deepEqual(page.errors, []);
  const ctx = page.context();
  const view = ctx.recommendation.payPeriodViews.find(period => period.start === start);
  const total = bill ? bill.amount : 0;
  const paidAmount = paid ? total : 0;
  const sum = view.stackSummary.bills;
  assert.deepEqual([sum.paid, sum.other, sum.paidTrust, sum.trust], [paidAmount, total, trust, trust],
    'published paid amount, bill load and trust for this period');

  const card = page.blockHtml('cards').match(/<details\b[^>]*data-stack-card="bills"[\s\S]*?<\/details>/)?.[0];
  assert.ok(card, 'the Bills card exists in the selected period');
  const head = card.split('</summary>')[0];
  const figure = head.match(/<span class="sc-f([^"]*)">([^<]+)<i>([^<]+)<\/i>/);
  assert.deepEqual(figure && [figure[2], figure[3]], ['$' + paidAmount, ' / $' + total], 'printed paid and owed');
  // The heading (paid / total) has no tap-in sheet, so it carries its trust on the card (lead ruling on pre-review
  // 7074755817); a bill row prints plain and its trust is in its sheet, checked below.
  assert.equal(figure[1].includes('stack-est'), trust === 'estimated', 'the heading carries its trust');
  const rows = [...card.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/g)].map(match => match[0]);
  assert.equal(rows.length, bill ? 1 : 0, 'the period lists each counted bill once');
  if (!bill) return;

  const matches = view.bills.filter(row => row.id === bill.id && row.date === bill.date);
  assert.equal(matches.length, 1, 'the selected period has exactly this occurrence');
  const [row] = matches;
  assert.deepEqual([row.paidState, row.stackBillPaymentEvidence, row.stackBillPaid, row.stackBillAmount, row.stackBillAmountTrust],
    [paid ? 'paid' : 'not-paid', paid ? 'posted-equal' : 'none', paid, total, trust], 'payment evidence on this occurrence');
  const target = rows[0].match(/data-stack-sheet="([^"]+)"/)?.[1];
  assert.equal(target, 'bill:' + bill.id + '@' + bill.date, 'the visible row opens this occurrence');
  assert.ok(rows[0].includes('>' + bill.label + '</span>'), 'the row names the bill');
  const amount = rows[0].match(/<span class="sc-a([^"]*)" aria-label="([^"]+)">([^<]+)<\/span>/);
  assert.deepEqual(amount && [amount[2], amount[3]], [(paid ? 'Paid $' : 'Planned $') + total, '$' + total],
    'the row states what its amount represents');
  assert.equal(amount[1].includes('stack-est'), false, 'the row amount is never greyed on the card');
  assert.deepEqual([rows[0].includes('aria-label="Paid"'), rows[0].includes('✓')], [paid, paid],
    'the confirmed row carries an accessible, visible Paid check');

  const sheet = page.sandbox.StackSheet.html(ctx, target);
  assert.ok(sheet, 'the row target resolves to a bill sheet');
  const big = sheet.match(/<div class="stack-sheet-big stack-n([^"]*)">/);
  assert.ok(big, 'the sheet prints the occurrence amount');
  assert.equal(big[1].includes('stack-est'), trust === 'estimated', 'the tap-in sheet carries the amount\'s trust');
  // An earlier occurrence can have its own check. Only the tapped bill's headline counts here.
  const headline = sheet.split('<ul class="stack-sheet-hist">')[0];
  assert.ok(headline.includes('>' + bill.label + '</h3>'), 'the sheet names the tapped bill');
  const shown = headline.match(/<div class="stack-sheet-big stack-n([^"]*)">([^<]+)<\/div>/);
  assert.equal(shown?.[2], '$' + total, 'the sheet shows the selected occurrence amount');
  assert.equal(shown[1].includes('stack-est'), trust === 'estimated', 'the sheet carries the occurrence trust');
  assert.deepEqual([headline.includes('aria-label="Paid"'), headline.includes('✓')], [paid, paid],
    'the sheet marks only the confirmed occurrence');
  if (paid) assert.doesNotMatch(rows[0] + headline, /trusted on due date|not seen/i,
    'a posted payment is never described as schedule-only');
}

module.exports = { assertBillPeriod };
