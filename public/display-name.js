'use strict';
/* The one place that decides what name a purchase is shown under.
 *
 * Display only. A transaction whose sanitized row carries `displayedNote`
 * (the bounded text of a Lunch Money note line that starts "item:", built by
 * displayedItemNote in scripts/provider-observe.js) is shown by that item text
 * instead of the bank payee. Every other row is shown exactly as before.
 *
 * Never an input to matching. Bill and subscription matching, classifiers and
 * Forecast keep reading `displayedPayee` / `originalMerchant`; this function
 * returns a string for rendering and writes nothing back to the row. Callers
 * must still escape the result. Pure: no DOM, no clock, no provider call. */
(function init(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DisplayName = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildApi() {
  // Same bound as the observer's DISPLAYED_NOTE_MAX_CHARS: a name has to fit
  // one line of the Spent list on a phone. Applied again here so a packet from
  // any source can never print an unbounded name.
  const MAX_CHARS = 60;
  const clean = value => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  function cap(text) {
    const chars = Array.from(text);
    return chars.length <= MAX_CHARS ? text : chars.slice(0, MAX_CHARS - 1).join('').trimEnd() + '…';
  }
  // The item text alone, or '' when the row has none.
  function itemName(tx) {
    return tx && typeof tx === 'object' ? cap(clean(tx.displayedNote)) : '';
  }
  // Item text, else the payee as the surface showed it before (displayed, then
  // original), else `fallback`.
  function displayName(tx, fallback) {
    const item = itemName(tx);
    if (item) return item;
    if (tx && typeof tx === 'object') {
      const displayed = clean(tx.displayedPayee);
      if (displayed) return displayed;
      const original = clean(tx.originalMerchant);
      if (original) return original;
    }
    return fallback == null ? '' : String(fallback);
  }
  return { displayName, itemName, MAX_CHARS };
});
