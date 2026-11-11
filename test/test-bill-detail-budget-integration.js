'use strict';
// Actual Budget helpers and Forecast, with only App's served-data/DOM boundary
// held. The full document/App.boot/interaction path has a separate browser proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const F = require('../public/forecast');
const Detail = require('../public/bill-detail');
const { fixture, cardObservation, publication } = require('./test-bill-detail');
const data = fixture();
const before = JSON.stringify(data);
const advice = publication(data), forecastBefore = JSON.stringify(advice);
const period = advice.defaultView.calendarPeriods[0];
const context = vm.createContext({ Forecast: F, BillDetail: Detail, console,
  served: data, period,
  document: { addEventListener() {}, querySelectorAll() { return []; },
    getElementById() { return null; }, documentElement: { dataset: {}, style: {} } },
  window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
  localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/' },
  addEventListener() {},
});
vm.runInContext(fs.readFileSync(require.resolve('../public/app.js'), 'utf8'), context);
vm.runInContext(`App.boot = () => {}; App.once = () => {}; App.register = () => {};
  Object.defineProperty(App, 'data', { get: () => served });`, context);
vm.runInContext(fs.readFileSync(require.resolve('../public/plan.js'), 'utf8'), context);
const render = () => vm.runInContext('calendarPeriodBillsHtml(period)', context);
const html = render();
assert.match(html, /<details class="bill-detail" data-bill-detail><summary class="operating-line"/);
assert.match(html, /data-period-bill="bill" data-bill-status="PAID" data-bill-date="2026-08-19"/);
assert.match(html, /≈ −\$97.50<\/span><\/summary>/, 'incumbent estimated signed amount');
assert.match(html, /Planned<\/dt><dd>\$100.00/);
assert.match(html, /Actual<\/dt><dd>\$97.50/);
assert.match(html, /Remaining<\/dt><dd>\$0.00/);
assert.match(html, /Transaction date<\/dt><dd>2026-08-18/);
assert.match(html, /Transaction amount<\/dt><dd>\$97.50 \(debit\)/);
assert.match(html, /Transaction account<\/dt><dd>Synthetic bills account/);
assert.doesNotMatch(html, /tx-1|<details[^>]*\bopen\b/);

// A refreshed served packet replaces evidence even if the printed Forecast
// bill row is unchanged. There is no component packet or transaction-id cache.
context.served = structuredClone(data);
context.served.liveOverlay.currentPeriodActuals.representedActuals = [];
assert.match(render(), /marked PAID by Forecast. Transaction evidence is unavailable/);
assert.doesNotMatch(render(), /Transaction date|2026-08-18/);
context.served = data;
assert.match(render(), /Transaction date<\/dt><dd>2026-08-18/);

// Identical bill id in a different period cannot reuse the current payment.
context.period = advice.defaultView.calendarPeriods[1];
assert.match(render(), /data-period-bill="bill" data-bill-status="still due" data-bill-date="2026-09-02"/);
assert.doesNotMatch(render(), /Transaction date|2026-08-18/);
assert.match(render(), /Missing evidence does not mean unpaid/);
context.period = { ...period, operatingPlanUnavailable: true };
assert.match(render(), /data-operating-plan="unavailable"/);
assert.doesNotMatch(render(), /data-bill-detail|Transaction date/);

context.row = { ...period.bills[0], id: 'bill" onmouseover="bad', label: '<img src=x onerror=bad>',
  payerLabel: '<svg onload=bad>' };
const hostile = vm.runInContext('periodBillLine(row)', context);
assert.match(hostile, /data-period-bill="bill&quot; onmouseover=&quot;bad"/);
assert.doesNotMatch(hostile, /<img|<svg| onmouseover="bad/);
context.row = { ...period.bills[0], date: null, needsDate: true, status: 'needs-date' };
const undated = vm.runInContext('periodBillLine(row)', context);
assert.match(undated, /data-bill-status="needs confirmation"/);
assert.doesNotMatch(undated, /data-bill-date=|Transaction date/);

assert.equal(JSON.stringify(data), before);
assert.equal(JSON.stringify(advice), forecastBefore);
assert.equal(JSON.stringify(publication(data)), forecastBefore);
for (const mode of ['posted', 'split', 'unknown', 'pending', 'refund', 'reversal']) {
  const card = cardObservation(mode), advice = publication(card);
  const before = JSON.stringify({ data: card, advice });
  context.served = card;
  context.period = advice.defaultView.calendarPeriods[0];
  const output = render();
  if (mode === 'posted' || mode === 'split' || mode === 'unknown') {
    assert.match(output, mode === 'split' ? /\$-125\.00 \(credit\)/ : /\$-250\.00 \(credit\)/);
    assert.match(output, /Actual<\/dt><dd>\$-250\.00/);
    assert.match(output, /−\$250.00<\/span><\/summary>/, 'Forecast movement remains its supplied outflow');
    assert.doesNotMatch(output, /≈ −\$250.00<\/span><\/summary>/,
      'linked posted card actual is independent of estimated schedule confidence');
    assert.match(output, /sign alone does not identify a payment, refund or reversal/);
  } else {
    assert.match(output, /Transaction evidence is unavailable/);
    assert.doesNotMatch(output, /\(credit\)/);
  }
  assert.equal(JSON.stringify({ data: card, advice: publication(card) }), before);
}
const document = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
assert.match(document, /href="\/bill-detail.css"/);
assert.ok(document.indexOf('src="/bill-detail.js"') < document.indexOf('src="/plan.js"'));
const registered = new Set(require('./suites.json').map(([, file]) => file));
assert.ok(registered.has('test-bill-detail.js'));
assert.ok(registered.has('test-bill-detail-budget-integration.js'));
console.log('PASS Budget bill evidence: actual period printer, served-packet replacement, exact period identity, unavailable barrier, hooks, escaping and unchanged Forecast');
