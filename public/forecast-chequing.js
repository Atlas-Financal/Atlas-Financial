'use strict';
/* Forecast-owned household chequing availability.
 *
 * Narrow reporting authority, not a second planner. "Available in chequing"
 * is the current usable chequing position plus unused Chequing B overdraft:
 * max(0, Chequing A) + max(0, Chequing B) + max(0, limit − used − pending).
 * Used overdraft is max(0, −Chequing B). Savings, cards, and HELOC never enter.
 *
 * Current observed Chequing A/B win over the dated Forecast opening when
 * live-plan attached a complete freshness-qualified `observedCash` packet.
 * That packet does not rewrite startingCashAmount, paydayAllocation,
 * live Current Balance (posted household chequing cash, not this overdraft
 * headline), currentPeriodAction, LEFT OVER, or any Forecast cash walk, and grants no
 * permission to borrow. Overdraft remains borrowed capacity, not cash.
 */
(function init(root, factory) {
  const forecast = typeof module !== 'undefined' && module.exports
    ? require('./forecast.js') : root && root.Forecast;
  const api = factory(forecast);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.Forecast) root.Forecast.chequingAvailability = api.chequingAvailability;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildApi(Forecast) {
  const roundCent = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

  function unavailable(reason) {
    return {
      status: 'unavailable',
      reason,
      chequingBalance: null,
      overdraftLimit: null,
      overdraftUsed: null,
      overdraftRemaining: null,
      available: null,
      includesBorrowing: false,
      accountBalances: [],
      asOf: null,
      cashSource: null,
    };
  }

  // The one Forecast reader of a chequing row's numeric evidence: null for
  // `unknown: true`, null/blank/non-numeric values (never a coerced $0).
  const rowValue = row => Forecast.householdChequingRowValue(row);

  function observedChequing(liveOverlay) {
    const packet = liveOverlay && liveOverlay.observedCash;
    if (!packet || packet.complete !== true || !Array.isArray(packet.accounts)) return null;
    const aValue = rowValue(packet.accounts.find(row => row && row.id === 'chequing-a'));
    const bValue = rowValue(packet.accounts.find(row => row && row.id === 'chequing-b'));
    if (aValue == null || bValue == null) return null;
    return {
      aValue,
      bValue,
      asOf: packet.asOf || liveOverlay.observedAsOf || null,
      source: 'observed-cash',
    };
  }

  function openingChequing(plan) {
    const cash = plan && plan.startingCash;
    const rows = cash && Array.isArray(cash.breakdown) ? cash.breakdown : [];
    const aValue = rowValue(rows.find(row => row && row.id === 'chequing-a'));
    const bValue = rowValue(rows.find(row => row && row.id === 'chequing-b'));
    if (aValue == null || bValue == null) return null;
    return {
      aValue,
      bValue,
      asOf: plan && plan.opening && plan.opening.asOf || null,
      source: 'opening',
    };
  }

  function chequingAvailability(plan, extraFacilities, liveOverlay) {
    const cash = observedChequing(liveOverlay) || openingChequing(plan);
    if (!cash) return unavailable('chequing-opening-missing');

    const aValue = cash.aValue;
    const bValue = cash.bValue;
    const facilities = Array.isArray(extraFacilities) ? extraFacilities : [];
    const overdraft = facilities.find(facility =>
      facility && facility.cash === 'chequing-b' && Number.isFinite(Number(facility.limit)));
    if (!overdraft) return unavailable('chequing-b-overdraft-missing');

    const limit = Math.max(0, Number(overdraft.limit));
    const pending = Number.isFinite(Number(overdraft.pending))
      ? Math.max(0, Number(overdraft.pending)) : 0;
    const chequingBalance = roundCent(aValue + bValue);
    const overdraftUsed = roundCent(Math.max(0, -bValue));
    const overdraftRemaining = roundCent(Math.max(0, limit - overdraftUsed - pending));
    const positiveChequing = roundCent(Math.max(0, aValue) + Math.max(0, bValue));
    const available = roundCent(Math.max(0, positiveChequing + overdraftRemaining));

    return {
      status: 'available',
      reason: null,
      chequingBalance,
      overdraftLimit: roundCent(limit),
      overdraftUsed,
      overdraftRemaining,
      available,
      includesBorrowing: limit > 0,
      accountBalances: [
        { id: 'chequing-a', value: roundCent(aValue) },
        { id: 'chequing-b', value: roundCent(bValue) },
      ],
      overdraftId: overdraft.id || null,
      asOf: cash.asOf,
      cashSource: cash.source,
    };
  }

  return { chequingAvailability };
});
