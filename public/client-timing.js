/* Browser-side page-load timing (lead dispatch, 2026-11-22; the NEXT PR named on #1553).
 *
 * After the page's first render, one small beacon goes to the same origin: whole-millisecond durations of the data
 * fetch, the Forecast compute inside that render, the rest of that render, and the time from navigation start to the
 * end of that render; a closed page enum; and a closed device class from a coarse media check (never the user-agent
 * string). Nothing else: no figure, no data, no URL, no query, no identifier. The server writes one closed log line.
 *
 * Forecast compute is the page's own Forecast.recommend call(s) during the first render: the Stack shell's
 * (stack-shell.js prepare) and the classic page's (plan.js renderPlan). Each call site brackets its call with
 * computeStart()/computeEnd() as plain statements in the same function, so no wrapper sits in any call stack and
 * Forecast is never replaced. Forecast reads made outside those calls count as render. Outside the first render the
 * brackets do nothing. Any failure here drops the beacon; it never changes what the page shows.
 */
(function (root) {
  'use strict';
  const CAP_MS = 600000;
  const ENDPOINT = '/client-timing';
  let fetchStarted = null, fetchMs = null, done = false;
  let measuring = false, computeMs = 0, openCompute = 0, broken = false;
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
  function send(record) {
    try {
      root.fetch(ENDPOINT, { method: 'POST', credentials: 'same-origin', keepalive: true, cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) }).catch(() => {});
    } catch (_) { /* timing only */ }
  }

  root.AtlasClientTiming = {
    fetchStart() { if (!done && fetchStarted === null) fetchStarted = now(); },
    fetchEnd() { if (!done && fetchStarted !== null && fetchMs === null) fetchMs = now() - fetchStarted; },
    // A Forecast compute bracket: a token while the first render is being measured, else null.
    computeStart() {
      if (!measuring) return null;
      openCompute++;
      return { at: now() };
    },
    computeEnd(token) {
      if (!measuring || !token || typeof token.at !== 'number' || token.ended) return;
      token.ended = true;
      openCompute--;
      computeMs += now() - token.at;
    },
    // The first render: runs `render` (always exactly once) and, the first time only, sends the beacon.
    firstRender(render) {
      if (done || fetchMs === null) return render();
      done = true;
      measuring = true;
      const started = now();
      try { render(); }
      catch (error) { broken = true; throw error; }
      finally { measuring = false; }
      // A bracket left open (a call that threw inside a caught render) means compute is unknown: no beacon.
      if (broken || openCompute !== 0) return undefined;
      const renderMs = now() - started;
      send({ page: pageOf(), device: deviceClass(), ms: { fetch: whole(fetchMs), compute: whole(computeMs),
        render: whole(Math.max(0, renderMs - computeMs)), total: whole(now()) } });
      return undefined;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
