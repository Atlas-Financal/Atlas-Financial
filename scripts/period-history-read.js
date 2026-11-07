'use strict';
// Read side of the hosted period-history archive (#818). Attaches captured
// period records to the browser's /data.json as `periodHistory`, so Forecast
// can reprint a completed pay period as it closed.
//
// Same activation switch as capture: off unless ATLAS_PERIOD_HISTORY_CAPTURE
// is exactly 'on'. withHistory() is synchronous, never throws and never waits on
// the store: it serves the last completed read (or nothing) and, when that
// read is older than REFRESH_MS, starts one background read. A failed or slow
// read leaves the served document exactly as it would be without history.
// Only the fields Forecast reprints leave the archive.
const FLAG = 'ATLAS_PERIOD_HISTORY_CAPTURE';
const REFRESH_MS = 10 * 60 * 1000;
const READ_TIMEOUT_MS = 60000;

function served(record) {
  const c = record && record.content;
  if (!c || !c.period || !c.publication) return null;
  return {
    schema: record.schema, capturedAt: record.capturedAt,
    content: { period: c.period, kind: c.kind, asOf: c.asOf ?? null, closingState: c.closingState ?? null,
      planBasis: c.planBasis ?? null,
      provenance: { policyFingerprint: c.provenance && c.provenance.policyFingerprint || null },
      publication: c.publication },
  };
}

function create({ env = process.env, openStore, clock = () => Date.now(), log = line => console.log(line) } = {}) {
  const open = openStore || (() => require('./private-period-history-postgres').openPeriodHistoryPostgres({ env }));
  let records = null, loadedAt = -Infinity, loading = false;
  async function load() {
    let store = null;
    try {
      store = await open();
      const list = await store.read();
      const out = [];
      for (const meta of list) {
        if (!meta || !['closing', 'original', 'first-observed', 'reconstructed', 'plan-amendment'].includes(meta.kind)) continue;
        const row = served(await store.read({ revisionId: meta.revisionId }));
        if (row) out.push(row);
      }
      records = out;
      log(JSON.stringify({ type: 'period-history-read', outcome: 'read', records: out.length }));
    } catch (error) {
      const code = error && typeof error.code === 'string' && /^history-[a-z-]+$/.test(error.code) ? error.code : 'history-read-failed';
      log(JSON.stringify({ type: 'period-history-read', outcome: code, records: records ? records.length : 0 }));
    } finally {
      if (store && typeof store.retire === 'function') { try { await store.retire(); } catch (_) { /* owner retires */ } }
    }
  }
  function refresh() {
    if (loading || clock() - loadedAt < REFRESH_MS) return;
    loading = true; loadedAt = clock();
    let timer;
    Promise.race([load(), new Promise(resolve => { timer = setTimeout(resolve, READ_TIMEOUT_MS); if (timer.unref) timer.unref(); })])
      .catch(() => {}).finally(() => { clearTimeout(timer); loading = false; });
  }
  function withHistory(data) {
    try {
      if (!env || env[FLAG] !== 'on' || !data || typeof data !== 'object') return data;
      refresh();
      if (!records) return data;
      return { ...data, periodHistory: JSON.parse(JSON.stringify(records)) };
    } catch (_) { return data; }
  }
  return Object.freeze({ withHistory });
}

module.exports = { FLAG, REFRESH_MS, create, served };
