'use strict';
// Test helper for page tests that stub Forecast.stackCreditLines with invented lines: give each line the `target` Forecast
// publishes (OD-028) in the simplest case, equal to its minimum (no new charges above it, not over the limit). A minimum
// of "no-minimum-due-in-period" is a $0 target (nothing to repay); any other withheld minimum withholds the target. The
// page prints the published target and never computes it, so this keeps each stub's existing "X / minimum" reading, and
// the tests that need a target above the minimum set it explicitly. Invented data only.
function targetFromMinimum(line) {
  if (!line || typeof line !== 'object' || Object.hasOwn(line, 'target')) return line;
  const m = line.minimum || { amount: null, trust: 'unavailable', reasons: [] };
  const noneDue = m.amount == null && Array.isArray(m.reasons) && m.reasons.includes('no-minimum-due-in-period');
  const target = m.amount != null ? { amount: m.amount, trust: m.trust, reasons: [] }
    : noneDue ? { amount: 0, trust: 'calculated', reasons: [] }
    : { amount: null, trust: 'unavailable', reasons: ['minimum-unavailable'] };
  return { ...line, target: { ...target, newCharges: null, minimum: m.amount, overLimitBy: 0 } };
}
const withTargets = lines => (Array.isArray(lines) ? lines.map(targetFromMinimum) : lines);
module.exports = { targetFromMinimum, withTargets };
