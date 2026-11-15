'use strict';
// Authorized addition (F1, Money out, to confirm): every pay period publishes
// `moneyOutToConfirm` (null, or {posted, pending, count, pendingCount} when an
// unproven posted or pending chequing debit is filed as Transfer or Payment).
// Frozen-engine parity suites validate the field here, then remove exactly that
// key before comparing with the older engine. They also run both engines on a
// fixture packet that holds none of those rows (`opts.noTransfer`), so no
// household figure moves in the comparison; every other field stays byte-compared.
const assert = require('node:assert/strict');
const KEY = 'moneyOutToConfirm';
function stripMoneyOutToConfirm(advice) {
  let validated = 0;
  const seen = new Set();
  const walk = node => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Object.hasOwn(node, KEY)) {
      const value = node[KEY];
      if (value !== null) {
        assert.ok(value && typeof value === 'object', 'moneyOutToConfirm is null or a summary object');
        for (const k of ['posted', 'pending', 'count', 'pendingCount']) {
          assert.ok(typeof value[k] === 'number' && Number.isFinite(value[k]) && value[k] >= 0, 'moneyOutToConfirm.' + k + ' is a finite amount or count');
        }
      }
      delete node[KEY];
      validated++;
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(advice);
  return { advice, validated };
}
module.exports = { stripMoneyOutToConfirm };
