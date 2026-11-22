'use strict';
const assert = require('node:assert/strict');
const { loadStackPage } = require('./budget-page-harness');

async function loadRefundPeriod(data) {
  const page = await loadStackPage({ data });
  assert.equal(page.status(), 'rendered', 'the Stack page renders');
  assert.deepEqual(page.errors, [], 'the Stack boot has no page errors');
  const context = page.context();
  const period = context.recommendation.payPeriodViews.find(v => v.start === page.selectedKey());
  assert.ok(period?.role === 'active' && period.start <= data.meta.asOf && data.meta.asOf <= period.end,
    'the selected pay period contains the observation');
  const category = id => period.householdBudget.find(row => row.id === id);
  return { page, period, category };
}

// The expected cents, printed headline and signed transaction lines come from the
// invented inputs. A missing detail target or an empty sheet must fail the proof.
function assertRefundCategory(stack, id, { spent, headline, transactions }) {
  const row = stack.category(id);
  assert.equal(row?.spent, spent, 'published category spend to the cent');
  const key = 'budget:' + id;
  assert.ok(stack.page.blockHtml('cards').includes('data-stack-sheet="' + key + '"'), 'the Budget card opens this category');
  const html = stack.page.sandbox.StackSheet.html(stack.page.context(), key);
  assert.ok(html, 'the selected category has a Stack sheet');
  const printed = /class="stack-sheet-big stack-n"><span[^>]*>([^<]*)<\/span>/.exec(html);
  assert.equal(printed?.[1], headline, 'the sheet prints the category spend');
  const lines = Array.from(html.matchAll(/class="stack-sheet-txl">([^<]*)<\/span><span class="stack-sheet-txa stack-n">([^<]*)<\/span>/g),
    match => [match[1], match[2]]);
  assert.equal((html.match(/<li\b/g) || []).length, transactions.length, 'the sheet has exactly the expected number of transactions');
  assert.deepEqual(lines, transactions, 'the sheet lists each expected name and signed amount once');
  return html;
}

module.exports = { loadRefundPeriod, assertRefundCategory };
