'use strict';
// Authorized addition (#931, H5): completed (lookback) pay periods publish
// `unconfirmedBills` and `unconfirmedBillsTrust`. Frozen-engine parity
// suites validate the pair here, then remove exactly these two keys before
// comparing with the older engine, as they already do for other
// authorized additions. Every other field stays byte-compared.
const assert = require('node:assert/strict');
const KEYS = ['unconfirmedBills', 'unconfirmedBillsTrust'];
function stripUnconfirmedBills(advice) {
  let validated = 0;
  const seen = new Set();
  const walk = node => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Object.hasOwn(node, 'unconfirmedBills') || Object.hasOwn(node, 'unconfirmedBillsTrust')) {
      assert.equal(node.lookback, true, 'unconfirmedBills is published on completed periods only');
      const amount = node.unconfirmedBills, trust = node.unconfirmedBillsTrust;
      if (amount === null) assert.equal(trust, 'unavailable', 'unknown unconfirmedBills carries unavailable trust');
      else {
        assert.ok(typeof amount === 'number' && Number.isFinite(amount) && amount >= 0, 'unconfirmedBills is a finite amount');
        assert.ok(trust === 'calculated' || trust === 'estimated', 'known unconfirmedBills carries its amount trust');
      }
      for (const key of KEYS) delete node[key];
      validated++;
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(advice);
  return { advice, validated };
}
module.exports = { stripUnconfirmedBills };
