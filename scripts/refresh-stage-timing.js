'use strict';
// Execution-local diagnostics only. No inputs, outputs or error values enter
// the timing state. Nested stage durations are inclusive, not additive.
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const context = new AsyncLocalStorage();
const MESSAGE = 'live-refresh-stage-progress';
const FIELDS = Object.freeze(['providerAcquireMs', 'normalizeMs', 'overlayMs', 'forecastMs', 'sourceReplayMs']);
// Per-read provider acquisition wall ms (timing only; closed names, no payload).
// Reads run in parallel, so these overlap and do not sum to providerAcquireMs.
const READS = Object.freeze(['plaidBalances', 'manualBalances', 'categories', 'tags', 'transactions', 'pending',
  'recurring', 'budgets', 'amountHistory']);
const KEYS = ['workerComplete', ...FIELDS, 'providerReads'];
const OUTCOMES = ['completed', 'live-refresh-cancelled', 'live-refresh-timeout', 'live-refresh-unavailable', 'live-refresh-invalidated'];
const duration = value => Number.isFinite(value) && value >= 0;
function emptyReads() { return Object.fromEntries(READS.map(name => [name, null])); }
function empty() {
  return Object.fromEntries([['workerComplete', false], ...FIELDS.map(key => [key, null]), ['providerReads', emptyReads()]]);
}
function acceptReads(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== READS.length
    || !READS.every(name => Object.hasOwn(value, name) && (value[name] === null || duration(value[name])))) return null;
  return Object.fromEntries(READS.map(name => [name, value[name]]));
}
function accept(value) {
  if (!value || Object.keys(value).length !== KEYS.length || !KEYS.every(key => Object.hasOwn(value, key))
    || typeof value.workerComplete !== 'boolean'
    || !FIELDS.every(key => value[key] === null || duration(value[key]))) return null;
  const reads = acceptReads(value.providerReads);
  if (!reads) return null;
  return Object.fromEntries(KEYS.map(key => [key, key === 'providerReads' ? reads : value[key]]));
}
function add(state, key, start) {
  const elapsed = performance.now() - start;
  const next = (state.values[key] || 0) + Math.max(0, elapsed);
  if (duration(next)) state.values[key] = next;
  // A closed transport failure cannot affect a financial result or exception.
  try { state.onUpdate?.({ ...state.values }); } catch (_) { /* Diagnostics only. */ }
}
async function run(invoke, onUpdate) {
  const state = { values: empty(), onUpdate };
  return context.run(state, async () => {
    try { return await invoke(); }
    finally {
      state.values.workerComplete = true;
      try { onUpdate?.({ ...state.values }); } catch (_) { /* Diagnostics only. */ }
    }
  });
}
function sync(key, invoke) {
  const state = context.getStore();
  if (!state || !FIELDS.includes(key)) return invoke();
  const start = performance.now();
  try { return invoke(); } finally { add(state, key, start); }
}
// One provider read's wall ms, inside a run() context; anything else is ignored.
function providerRead(name, ms) {
  const state = context.getStore();
  if (!state || !READS.includes(name) || !duration(ms)) return;
  state.values.providerReads = { ...state.values.providerReads, [name]: ms };
  try { state.onUpdate?.({ ...state.values }); } catch (_) { /* Diagnostics only. */ }
}
async function asyncStage(key, invoke) {
  const state = context.getStore();
  if (!state || !FIELDS.includes(key)) return invoke();
  const start = performance.now();
  try { return await invoke(); } finally { add(state, key, start); }
}
function record(value, source, outcome, qualified, publicationMs) {
  return { type: 'live-refresh-stages', source: source === 'memory' ? 'memory' : 'provider',
    outcome: OUTCOMES.includes(outcome) ? outcome : 'live-refresh-unavailable',
    qualified: typeof qualified === 'boolean' ? qualified : null,
    ...(accept(value) || empty()), publicationMs: duration(publicationMs) ? publicationMs : null };
}
module.exports = { MESSAGE, FIELDS, READS, run, sync, async: asyncStage, providerRead, accept, record };
