'use strict';
// Browser-side page-load timing beacon (lead dispatch, 2026-11-22; the NEXT
// PR named on #1553). public/client-timing.js sends one small body after the
// page's first render; this module checks it against a strict closed schema
// and writes ONE closed `atlas-client-timing` line on stdout. Server log only.
//
// Closed schema, exactly these keys and nothing else:
//   { page: 'stack'|'budget', device: 'mobile'|'desktop'|'other',
//     ms: { fetch, compute, render, total } }  (whole ms, 0..600000)
// Anything else (an extra or missing key, a string, a fraction, a negative,
// a nested object, an array) is refused with 400 and no line. The line is
// rebuilt from the closed values; nothing from the body is copied through,
// and nothing is echoed back. Route-level guards (server.js): the existing
// session gate, a JSON-only parser with a 1 kB cap and no inflation, and the
// per-session cap below.
const PAGES = new Set(['stack', 'budget']);
const DEVICES = new Set(['mobile', 'desktop', 'other']);
const MS_KEYS = ['fetch', 'compute', 'render', 'total'];
const TOP_KEYS = ['device', 'ms', 'page'];
const CAP_MS = 600000;
const BODY_LIMIT = '1kb';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const sameKeys = (value, keys) => {
  const own = Object.keys(value).sort(), want = [...keys].sort();
  return own.length === want.length && own.every((key, i) => key === want[i]);
};
const wholeMs = value => Number.isInteger(value) && value >= 0 && value <= CAP_MS;

// The closed record, or null when the body is not exactly the schema.
function parse(body) {
  if (!plain(body) || !sameKeys(body, TOP_KEYS)) return null;
  if (typeof body.page !== 'string' || !PAGES.has(body.page)) return null;
  if (typeof body.device !== 'string' || !DEVICES.has(body.device)) return null;
  if (!plain(body.ms) || !sameKeys(body.ms, MS_KEYS) || !MS_KEYS.every(key => wholeMs(body.ms[key]))) return null;
  return { type: 'atlas-client-timing', page: body.page, device: body.device,
    ms: { fetch: body.ms.fetch, compute: body.ms.compute, render: body.ms.render, total: body.ms.total } };
}

// A simple per-session cap: at most LIMIT lines per session in WINDOW_MS.
// The key is the caller's opaque session key (server.js passes the signed
// session actor); the table is bounded, oldest entry evicted first.
function rateCap({ limit = 20, windowMs = 10 * 60 * 1000, maxKeys = 500, clock = Date.now } = {}) {
  const seen = new Map();
  return function allow(key) {
    const at = clock();
    const slot = seen.get(key);
    if (!slot || at - slot.start >= windowMs) {
      seen.delete(key);
      if (seen.size >= maxKeys) seen.delete(seen.keys().next().value);
      seen.set(key, { start: at, count: 1 });
      return true;
    }
    if (slot.count >= limit) return false;
    slot.count++;
    return true;
  };
}

module.exports = { parse, rateCap, BODY_LIMIT, CAP_MS };
