'use strict';

const assert = require('node:assert/strict');

const sources = {
  bills: 'stackSummary.bills.other',
  mortgage: 'stackSummary.bills.mortgage',
  credit: 'stackSummary.surplus.terms.credit',
  surplus: 'stackSummary.surplus.amount',
};

function dollars(amount, signed = false) {
  const whole = Math.round(Math.abs(amount));
  const sign = whole && amount < 0 ? '−' : whole && signed ? '+' : '';
  return sign + '$' + whole.toLocaleString('en-CA');
}

// Each expected occurrence is a bill from the invented input together with its
// independently assigned calendar date. The roster must contain it exactly once.
function assertStackBillPeriod(page, start, figures, occurrences) {
  assert.equal(page.status(), 'rendered', 'Stack mounted');
  assert.equal(page.selectPeriod(start), start, 'selected period chip');
  const view = page.context().recommendation.payPeriodViews.find(v => v.start === start);
  const waterfall = page.blockHtml('waterfall');
  assert.ok(waterfall.includes(`data-period="${start}"`), 'waterfall redrew for selected period');
  for (const [row, expected] of Object.entries(figures)) {
    const source = sources[row];
    const published = source.split('.').reduce((node, key) => node?.[key], view);
    const parts = waterfall.split(`data-row="${row}"`);
    assert.equal(parts.length, 2, `one ${row} row`);
    const cells = [...parts[1].split('data-row=')[0].matchAll(
      /<span class="n(?: [^"]*)?" data-source="([^"]+)"([^>]*)>([^<]*)<\/span>/g)];
    assert.equal(cells.length, 1, `one ${row} amount cell`);
    const [cell] = cells;
    assert.equal(cell[1], source, `${row} source`);
    if (expected === null) {
      assert.ok(published == null, `${row} withheld by Forecast`);
      assert.match(cell[2], /data-unpublished="true"/, `${row} withheld on Stack`);
      assert.equal(cell[3], '', `${row} has no invented amount`);
    } else {
      assert.equal(published, expected, `${row} published to the cent`);
      assert.doesNotMatch(cell[2], /data-unpublished/, `${row} available`);
      assert.equal(cell[3], dollars(expected, row === 'surplus'), `${row} displayed amount`);
    }
  }

  const card = /<details\b[^>]*data-stack-card="bills"[^>]*>[\s\S]*?<\/details>/.exec(page.blockHtml('cards'));
  assert.ok(card, 'selected Bills card');
  const rows = [...card[0].matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/g)].map(([html]) => {
    const key = /data-stack-sheet="bill:([^"]+)"/.exec(html);
    assert.ok(key, 'bill occurrence is reachable');
    return { key: key[1], html };
  });
  const keys = occurrences.map(([bill, date]) => `${bill.id}@${date}`);
  assert.deepEqual(rows.map(r => r.key).sort(), keys.slice().sort(), 'selected bill occurrences');
  for (const [index, [bill]] of occurrences.entries()) {
    const { html } = rows.find(r => r.key === keys[index]);
    assert.equal(/class="sc-n">([^<]*)</.exec(html)?.[1], bill.label, 'bill name');
    assert.equal(/class="sc-a(?: [^"]*)?"[^>]*>([^<]*)</.exec(html)?.[1], dollars(bill.amount), 'bill amount');
  }
}

module.exports = { assertStackBillPeriod };
