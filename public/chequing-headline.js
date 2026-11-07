'use strict';
/* Household presentation for Forecast.chequingAvailability.
 *
 * This file performs no financial arithmetic. It renders the Forecast-owned
 * chequing-capacity result on top of the existing cash waterfall and keeps the
 * cash-only Forecast allocation visibly separate from borrowed overdraft
 * capacity.
 */
(function init(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') api.boot(document);
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildApi() {
  const money2 = value => {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-CA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  const longDate = iso => {
    const date = new Date(String(iso) + 'T00:00:00Z');
    return Number.isNaN(date.getTime()) ? String(iso) : new Intl.DateTimeFormat('en-CA',
      { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(date);
  };

  function headlineModel(summary) {
    if (!summary || summary.status !== 'available') return null;
    return {
      available: money2(summary.available),
      chequingBalance: money2(summary.chequingBalance),
      overdraftRemaining: money2(summary.overdraftRemaining),
      includesBorrowing: summary.includesBorrowing === true,
      asOf: summary.asOf || null,
    };
  }

  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  function apply(doc, data, forecast) {
    if (!doc || !data || !forecast || typeof forecast.chequingAvailability !== 'function') return false;
    const summary = forecast.chequingAvailability(data.plan, data.revolvingExtra, data.liveOverlay);
    const model = headlineModel(summary);
    if (!model) return false;

    const waterfall = doc.getElementById('cash-waterfall');
    if (!waterfall) return false;

    const fact = waterfall.querySelector('.cash-flow-top .cash-flow-fact');
    if (fact) {
      const label = fact.querySelector('span');
      const value = fact.querySelector('strong');
      setText(label, 'Available in chequing · Calculated');
      setText(value, model.available);

      let note = fact.querySelector('.chequing-capacity-note');
      if (!note) {
        note = doc.createElement('p');
        note.className = 'cash-flow-note chequing-capacity-note';
        fact.appendChild(note);
      }
      const dating = data.liveOverlay && data.liveOverlay.applied === true
        && data.liveOverlay.balanceDating
        && data.liveOverlay.balanceDating.status === 'dated-latest-sync'
        && data.liveOverlay.balanceDating.balanceAsOf;
      setText(note,
        `${dating ? `Chequing balances as of ${longDate(dating)} (latest bank sync, not today)` : 'Actual chequing balances'} ${model.chequingBalance}. Unused overdraft ${model.overdraftRemaining} remains; using overdraft is borrowing, not cash. Available in chequing ${model.available}.`);
    }

    const firstBlock = waterfall.querySelector('.cash-flow-card .cash-flow-block');
    if (firstBlock) {
      setText(firstBlock.querySelector('h2'), 'Cash Atlas is planning with');
      const note = firstBlock.querySelector('.cash-flow-note');
      setText(note,
        'This is the separate cash-only Forecast pool. It can include spendable savings, but it never includes the overdraft above. Overdraft capacity is not cash and is not LEFT OVER.');
    }

    return true;
  }

  function boot(doc) {
    const run = () => {
      const app = typeof App !== 'undefined' ? App : null;
      const forecast = typeof Forecast !== 'undefined' ? Forecast : null;
      return !!(app && app.data && apply(doc, app.data, forecast));
    };

    if (typeof App !== 'undefined' && App && typeof App.register === 'function') {
      App.register(() => {
        if (typeof setTimeout === 'function') setTimeout(run, 0);
        else run();
      });
    }

    run();
    if (typeof MutationObserver === 'undefined') return null;
    const rootNode = doc.querySelector('.wrap') || doc.body;
    if (!rootNode) return null;
    const observer = new MutationObserver(() => run());
    observer.observe(rootNode, { childList: true, subtree: true, characterData: true });
    return observer;
  }

  return { money2, headlineModel, apply, boot };
});
