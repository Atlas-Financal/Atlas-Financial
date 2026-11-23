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
// Desk ruling (E) (#1573): Forecast publishes each view's Credit lines on the view (stackSummary.credit) and the page reads
// them there, calling no Forecast function. Page tests that stub Forecast.cardPeriodMovements / stackCreditLines keep their
// stubs: this stand-in plays Forecast, calling the stubs as Forecast does and placing the result on the selected view before
// the page reads it (no stub: no publication). Wrap a block renderer or a sheet's html with standIn.
function publishCredit(c) {
  const views = c && c.recommendation && Array.isArray(c.recommendation.payPeriodViews) ? c.recommendation.payPeriodViews : [];
  const view = views.find(v => v && v.start === c.selectedPeriodKey) || (c && !c.selectedPeriodKey ? views.find(v => v && v.role === 'current') : null);
  if (!view) return;
  const F = (c && c.Forecast) || {};
  const pub = typeof F.cardPeriodMovements === 'function'
    ? F.cardPeriodMovements(c.plan, c.data && c.data.debts, c.data && c.data.meta && c.data.meta.asOf, { start: view.start, end: view.end },
      { liveOverlay: null }) : null;
  const credit = typeof F.stackCreditLines === 'function' ? F.stackCreditLines(pub, view.stackSummary ? view.stackSummary.bills : null) : null;
  view.stackSummary = { ...(view.stackSummary || {}), credit: credit || null };
}
const standIn = fn => (first, c, ...rest) => {
  // A block renderer is (el, ctx); a sheet's html is (ctx, key).
  const ctx = c && typeof c === 'object' && c.recommendation ? c : first;
  publishCredit(ctx);
  return fn(first, c, ...rest);
};
module.exports = { targetFromMinimum, withTargets, publishCredit, standIn };
