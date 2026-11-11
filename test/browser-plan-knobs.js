'use strict';
/* Browser-suite helper: give the Budget page fixed worksheet inputs (for
 * example a weekly cap) without the retired stored-knob key.
 *
 * Since #1068 the page ignores and clears `hfd-plan-knobs-v1` (finish-line
 * audit finding 9), so a suite that seeded that key before load now renders
 * at the recommendation instead of the inputs its figures were written for.
 * This helper puts the same inputs back by the same route the old key took:
 * the page's own `state`, set in a once-hook that runs right after
 * plan.js's wireControls (which resets every knob from plan.defaults) and
 * before the first render. No production code changes and no test seam is
 * added to the page: the hook is registered from a Playwright init script.
 *
 * How it reaches the hook: plan.js registers `App.once(wireControls)` and
 * then calls `App.boot()`, which fetches the data. The init script wraps
 * `fetch`; on the first call made after plan.js has defined `state` (or at
 * DOMContentLoaded, whichever comes first) it registers one more once-hook.
 * Once-hooks run in registration order when the data arrives, so it runs
 * after wireControls and before the first render.
 *
 *   await page.addInitScript(applyPlanKnobsAfterWiring, { weeklyVariable: 40 });
 *   // CDP form: { source: planKnobsInitSource({ weeklyVariable: 0 }) }
 */
function applyPlanKnobsAfterWiring(knobs) {
  let registered = false;
  const register = () => {
    if (registered) return;
    /* global App, state */
    if (typeof App === 'undefined' || typeof state === 'undefined' || !App || typeof App.once !== 'function') return;
    registered = true;
    App.once(() => { Object.assign(state, JSON.parse(JSON.stringify(knobs))); });
  };
  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    register();
    return nativeFetch.apply(this, args);
  };
  document.addEventListener('DOMContentLoaded', register);
}

const planKnobsInitSource = knobs => `(${applyPlanKnobsAfterWiring.toString()})(${JSON.stringify(knobs)});`;

module.exports = { applyPlanKnobsAfterWiring, planKnobsInitSource };
