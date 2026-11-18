'use strict';
// A Forecast whose published plain text is hostile (stored-XSS proofs).
//
// Every object a page-facing Forecast function returns is walked and each
// non-empty string under a text-shaped key (label, reason, note, message,
// summary, ...) gets PAYLOAD appended. Ids, statuses, dates and numbers are
// left alone, so the page still takes its normal branches. Forecast's own
// internal calls are not wrapped, so the figures are the real ones. Only
// what the page reads is poisoned: a renderer that writes one of those
// strings into markup without escaping it is caught.
//
// One source for node and the browser: `install` is self-contained and is
// passed to Playwright's addInitScript as-is.
const PAYLOAD = '<img src=z data-poisoned-forecast onerror=alert(9)>';
const KEY_SOURCE = '(label|reason|note|message|short|summary|why|what|line|headline|title|detail|description|text|caption|name|payee|merchant)$';

function wrap(real, payload, keySource) {
  const keys = new RegExp(keySource, 'i');
  const poison = (value, depth, seen) => {
    if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return value;
    seen.add(value);
    for (const key of Object.keys(value)) {
      const x = value[key];
      if (typeof x === 'string' && x && keys.test(key)) value[key] = x + payload;
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
function install({ payload, keySource, wrapSource }) {
  const wrapFn = new Function(`return (${wrapSource})`)();
  let current;
  Object.defineProperty(window, 'Forecast', { configurable: true,
    get: () => current, set: real => { current = wrapFn(real, payload, keySource); } });
}

module.exports = {
  PAYLOAD, KEY_SOURCE,
  poisonedForecast: real => wrap(real, PAYLOAD, KEY_SOURCE),
  browserInit: [install, { payload: PAYLOAD, keySource: KEY_SOURCE, wrapSource: wrap.toString() }],
};
