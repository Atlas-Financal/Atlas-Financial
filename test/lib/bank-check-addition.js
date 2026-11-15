'use strict';
// Authorized addition (per-pay-period bank check, Forecast.periodBankCheck): every period row the recommendation publishes
// may carry `bankCheck`. Frozen-engine parity suites validate it here, then remove exactly this field before comparing with
// the older engine, as they already do for other authorized additions; every other field stays byte-compared. The validation
// covers the point of the addition: an Unavailable result carries a reason and no figure; an available one is tagged
// calculated or estimated (never more), its published identities hold in whole cents, and the tag never exceeds the table's
// (`trustBeforeAssumption`); a past or lookback period publishes only `not-saved-at-close`; a future period carries none.
// It fails when it validated nothing, and it deletes `bankCheck` only on a period node whose check it validated (or an
// identical copy of it).
const assert = require('node:assert/strict');
const cents = v => Math.round(Number(v) * 100);
function stripBankCheck(advice) {
  const views = Array.isArray(advice && advice.payPeriodViews) ? advice.payPeriodViews : [];
  const published = new Map();
  let validated = 0;
  for (const period of views) {
    if (!Object.hasOwn(period, 'bankCheck')) continue;
    assert.ok(period.timelineRole !== 'future', 'a future period carries no bank check');
    const check = period.bankCheck;
    assert.ok(['calculated', 'estimated', 'unavailable'].includes(check.status), 'bank check status is a published word');
    assert.equal(check.trust, check.status, 'the tag is the status');
    if (period.timelineRole !== 'current') {
      assert.equal(check.status, 'unavailable', 'a past period publishes no check');
      assert.equal(check.reasonCode, 'not-saved-at-close');
    }
    if (check.status === 'unavailable') {
      assert.equal(check.gap, null, 'Unavailable has no figure');
      assert.equal(typeof check.reason, 'string');
    } else {
      assert.ok(Number.isFinite(check.gap), 'an available check has a figure');
      assert.ok(check.trust !== 'calculated' || check.trustBeforeAssumption === 'calculated', 'never more certain than the design table');
      assert.equal(cents(check.opening.balance) + cents(check.countedIn) - cents(check.countedOut) + cents(check.gap), cents(check.closing.balance));
      assert.equal(cents(check.identity.a) - cents(check.identity.b) - cents(check.identity.c) + cents(check.identity.d), cents(check.gap));
    }
    published.set(period.start, check);
    validated++;
  }
  assert.ok(validated > 0, 'bankCheck was published and validated (nothing to exclude means the control proves nothing)');
  const seen = new Set();
  const walk = node => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Object.hasOwn(node, 'bankCheck')) {
      assert.deepEqual(node.bankCheck, published.get(node.start), 'a copy of bankCheck is the validated one');
      delete node.bankCheck;
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(advice);
  return { advice, validated };
}
module.exports = { stripBankCheck };
