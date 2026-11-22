/* Browser-side page-load timing (lead dispatch, 2026-11-22; the NEXT PR named on #1553).
 *
 * After the page's first render, one small beacon goes to the same origin: whole-millisecond durations of the data
 * fetch, the Forecast compute inside that render, the rest of that render, and the time from navigation start to the
 * end of that render; a closed page enum; and a closed device class from a coarse media check (never the user-agent
 * string). Nothing else: no figure, no data, no URL, no query, no identifier. The server writes one closed log line.
 *
 * Forecast compute is measured without changing Forecast: for the duration of the first render only, each Forecast
 * function is replaced by a transparent Proxy that adds the time of top-level calls (a nested call is not counted
 * twice), and the originals are restored before anything else runs. A Proxy keeps a function's own properties
 * (bill-detail.js reads one). Any failure here drops the beacon; it never changes what the page shows.
 */
(function (root) {
  'use strict';
  const CAP_MS = 600000;
  const ENDPOINT = '/client-timing';
  let fetchStarted = null, fetchMs = null, done = false;
  const now = () => root.performance.now();
  const whole = value => Math.max(0, Math.min(CAP_MS, Math.round(value)));

  function deviceClass() {
    try {
      const match = query => root.matchMedia(query).matches;
      if (match('(pointer: coarse)') && match('(max-width: 900px)')) return 'mobile';
      if (match('(pointer: fine)')) return 'desktop';
    } catch (_) { /* coarse check unavailable */ }
    return 'other';
  }
  function pageOf() {
    const html = root.document && root.document.documentElement;
    return html && html.classList && html.classList.contains('stack-view') ? 'stack' : 'budget';
  }

  // Wrap every Forecast function for one synchronous run; returns the run's result and the Forecast time.
  function timedForecast(run) {
    const F = root.Forecast;
    if (!F || typeof F !== 'object') return null;
    const originals = [];
    let depth = 0, spent = 0;
    try {
      for (const key of Object.keys(F)) {
        const fn = F[key];
        if (typeof fn !== 'function') continue;
        const timed = new Proxy(fn, { apply(target, self, args) {
          if (depth > 0) return Reflect.apply(target, self, args);
          depth++;
          const started = now();
          try { return Reflect.apply(target, self, args); } finally { spent += now() - started; depth--; }
        } });
        F[key] = timed;
        if (F[key] !== timed) throw new Error('not writable');
        originals.push([key, fn]);
      }
    } catch (_) {
      for (const [key, fn] of originals) F[key] = fn;
      return null;
    }
    const started = now();
    try { run(); } finally { for (const [key, fn] of originals) F[key] = fn; }
    return { renderMs: now() - started, forecastMs: spent };
  }

  function send(record) {
    try {
      root.fetch(ENDPOINT, { method: 'POST', credentials: 'same-origin', keepalive: true, cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) }).catch(() => {});
    } catch (_) { /* timing only */ }
  }

  root.AtlasClientTiming = {
    fetchStart() { if (!done && fetchStarted === null) fetchStarted = now(); },
    fetchEnd() { if (!done && fetchStarted !== null && fetchMs === null) fetchMs = now() - fetchStarted; },
    // The first render: runs `render` (always exactly once) and, the first time only, sends the beacon.
    firstRender(render) {
      if (done || fetchMs === null) return render();
      done = true;
      // Null means Forecast could not be timed and render has NOT run: run it untimed, with no beacon. A throw
      // from render propagates unchanged (the originals are already restored), also with no beacon.
      const timing = timedForecast(render);
      if (!timing) return render();
      send({ page: pageOf(), device: deviceClass(), ms: { fetch: whole(fetchMs), compute: whole(timing.forecastMs),
        render: whole(Math.max(0, timing.renderMs - timing.forecastMs)), total: whole(now()) } });
      return undefined;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
