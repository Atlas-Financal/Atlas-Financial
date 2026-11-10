'use strict';
// Diagnostic transport only. These fixed codes and bounded counts never decide
// qualification, coverage, figures, retention or write admission.
const CODES = new Set([
  'posted-duplicate', 'posted-duplicate-conflict', 'sync-evidence-stale',
  'sync-evidence-failed', 'sync-evidence-invalid', 'currency-unconfirmed',
  'cash-currency-unconfirmed', 'card-coverage-unconfirmed', 'dropped-row',
  'unmapped-account', 'posting-status-unconfirmed', 'split-unreconciled',
  'transactions-missing', 'window-bounds-missing', 'window-completion-unproven',
  'window-truncated', 'pending-coverage-incomplete', 'has-more-missing',
  'has-more-invalid', 'transactions-array-malformed', 'empty-page-with-more',
  'page-limit-reached', 'sanitization-failed', 'diagnostic-unavailable',
  'provider-unavailable', 'provider-request-timeout', 'stale-live-cash-evidence',
  'missing-live-cash-evidence', 'pending-freshness-unproven',
  'posted-window-truncated', 'posted-window-unproven',
]);
const MAX_COUNT = 1000000000;
function merge(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return target;
  for (const code of CODES) {
    const count = source[code];
    if (!Number.isSafeInteger(count) || count <= 0) continue;
    const before = Number.isSafeInteger(target[code]) && target[code] > 0 ? target[code] : 0;
    target[code] = Math.min(MAX_COUNT, before + Math.min(MAX_COUNT, count));
  }
  return target;
}
function record(source) {
  const reasons = merge({}, source || { 'diagnostic-unavailable': 1 });
  return { type: 'live-refresh-coverage', reasons };
}
module.exports = { merge, record };
