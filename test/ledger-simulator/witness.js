'use strict';

const assert = require('node:assert/strict');
const { world, date } = require('./household');
const { observation, publish, remember, digest } = require('./replay');
const { faults, targetFor } = require('./transport');
const { inspect } = require('./oracle');

// Cache only the immutable observation, never a display built against a prior
// household. Complete input identity includes opening stock, plan, accounts,
// identities and the bank rows visible on that date.
function observationReader(limit = 256) {
  const cache = new Map();
  return async (seed, day, events, fault) => {
    const input = world(seed, day, events),
      key = digest([fault || null, input]);
    if (!cache.has(key)) {
      if (cache.size >= limit) cache.delete(cache.keys().next().value);
      cache.set(key, await observation(seed, day, events, fault, input));
    }
    return cache.get(key);
  };
}

async function evaluate(c, events, read = observation, record = false) {
  const rows = [],
    rowIndex = new Map(),
    observations = [];
  const selected = new Set(events.flatMap((e) => e.rows.map((r) => r.id)));
  function capture(raw, role, fault) {
    if (!record) return;
    const source = raw.history.at(-1)?.day ?? raw.day;
    const target = targetFor(raw.payload, raw.day, fault);
    const refs = [];
    for (const tx of raw.payload.transactions) {
      if (!selected.has(tx.id) && !(tx.id === target && (faults[fault]?.row || faults[fault]?.between)))
        continue;
      const key = JSON.stringify(tx);
      if (!rowIndex.has(key)) {
        rowIndex.set(key, rows.length);
        rows.push(tx);
      }
      refs.push(rowIndex.get(key));
    }
    observations.push({
      day: date(raw.day),
      role,
      fault: fault || null,
      qualified: raw.qualified,
      sourceDay: date(source),
      inputDigest: raw.inputDigest,
      rows: refs,
    });
  }
  let previous, prior;
  for (let d = c.firstDay; d < c.day; d++) {
    const fault = c.priorFaults?.[d];
    const observed = await read(c.seed, d, events, fault);
    if (d === c.day - 1) {
      prior = publish(observed, previous);
      previous = prior.raw;
    } else previous = remember(observed, previous);
    capture(previous, 'history', fault);
  }
  let clean;
  if (c.fault) {
    clean = publish(await read(c.seed, c.day, events), previous);
    capture(clean.raw, 'clean');
  }
  const current = publish(await read(c.seed, c.day, events, c.fault), previous);
  capture(current.raw, 'reading', c.fault);
  let baseline;
  if (c.baselineDay != null) {
    baseline = publish(await read(c.seed, c.baselineDay, []));
    capture(baseline.raw, 'baseline');
  }
  const input = {
    ...c,
    events,
    view: current.view,
    prior: prior?.view,
    clean: clean?.view,
    baseline: baseline?.view,
  };
  const result = inspect(input);
  if (c.panel === 'retained-pending-topup') {
    // This supplements the current-day consensus with the precise historical
    // case. Both observed legs must prove yesterday's failure; today must
    // actually retain that same qualified publication.
    assert.ok(prior && clean && baseline);
    const old = inspect({ ...input, day: c.day - 1, view: prior.view, knownOnly: true });
    result.failures = old.failures
      .filter(
        (f) =>
          f.cause === 'topup' &&
          prior.view.qualified &&
          current.view.retained &&
          current.view.sourceDay === prior.raw.day &&
          current.view.retainedReceipt?.asOf === date(prior.raw.day) &&
          current.view.publishedAsOf === date(prior.raw.day) &&
          current.view.amounts.bad === prior.view.amounts.bad &&
          current.view.amounts.billsEnd === null
      )
      .map((f) => ({ ...f, figure: 'retained pending top-up / Bills period end' }));
  }
  return { ...result, rows, observations, current, prior, clean };
}

module.exports = { evaluate, observationReader };
