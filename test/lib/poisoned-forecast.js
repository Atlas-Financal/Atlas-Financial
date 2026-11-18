'use strict';
// A Forecast whose published plain text is hostile (stored-XSS proofs).
//
// Every object a page-facing Forecast function returns is walked and every
// non-empty string gets PAYLOAD appended, except under keys that name an
// identity or an enum the page branches on (keys ending in id, kind, status,
// date or trust: `id`, `debtId`, `incomeTrust`, `dueDate`) and values that
// are ISO dates (`asOf`, `start`, `end`). Numbers and booleans are left alone.
// Poisoning every other string, enums included, also proves the page never
// prints a Forecast code string as markup. Forecast's own
// internal calls are not wrapped, so the figures are the real ones. Only
// what the page reads is poisoned: a renderer that writes one of those
// strings into markup without escaping it is caught.
//
// One source for node and the browser: `install` is self-contained and is
// passed to Playwright's addInitScript as-is.
const PAYLOAD = '<img src=z data-poisoned-forecast onerror=alert(9)>';
// Keys left clean (case-insensitive suffix match).
const SKIP_SOURCE = '(id|kind|status|date|trust)$';
const ISO_DATE = '^\\d{4}-\\d{2}-\\d{2}(T[\\d:.]+Z?)?$';

function wrap(real, payload, skipSource, isoSource) {
  const skip = new RegExp(skipSource, 'i');
  const iso = new RegExp(isoSource);
  const poison = (value, depth, seen) => {
    if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return value;
    seen.add(value);
    for (const key of Object.keys(value)) {
      const x = value[key];
      if (typeof x === 'string' && x && !skip.test(key) && !iso.test(x)) value[key] = x + payload;
      else if (x && typeof x === 'object') poison(x, depth + 1, seen);
    }
    return value;
  };
  return new Proxy(real, { get(target, prop) {
    const f = target[prop];
    if (typeof f !== 'function') return f;
    return function poisoned(...args) {
      const out = f.apply(this, args);
      return out && typeof out === 'object' ? poison(out, 0, new WeakSet()) : out;
    };
  } });
}

// Browser: replace window.Forecast with the poisoned wrapper as forecast.js
// publishes it. Self-contained (no closure) so addInitScript can serialise it.
function install({ payload, skipSource, isoSource, wrapSource }) {
  const wrapFn = new Function(`return (${wrapSource})`)();
  let current;
  Object.defineProperty(window, 'Forecast', { configurable: true,
    get: () => current, set: real => { current = wrapFn(real, payload, skipSource, isoSource); } });
}

module.exports = {
  PAYLOAD, SKIP_SOURCE, ISO_DATE,
  poisonedForecast: real => wrap(real, PAYLOAD, SKIP_SOURCE, ISO_DATE),
  browserInit: [install, { payload: PAYLOAD, skipSource: SKIP_SOURCE, isoSource: ISO_DATE, wrapSource: wrap.toString() }],
};
