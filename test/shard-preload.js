'use strict';
/* Deterministic case sharding for suites that register plain top-level
 * node:test cases. Loaded with `--require` through NODE_OPTIONS by the pooled
 * CI runner only (test/test.js), never by `npm test` or a suite itself.
 *
 *   ATLAS_SHARD_INDEX  this shard, 0-based
 *   ATLAS_SHARD_COUNT  number of shards (1 runs everything)
 *   ATLAS_SHARD_REPORT file the report is written to when the process exits
 *   ATLAS_SHARD_MODE   'list' registers nothing and only records the cases
 *
 * The suite file is not changed and its assertions are not touched: this module
 * only decides which of the suite's own top-level `test(...)` registrations are
 * handed to node:test in this process. Case i belongs to shard i % count, by
 * registration order, which is fixed by the suite's source.
 *
 * Every shard sees every registration, so every shard reports the complete
 * ordered case list and the subset it ran. The runner refuses a result unless
 * all shards agree on the list and the subsets partition it exactly: a case
 * that no shard ran, or that two shards ran, is a failure, never a skip.
 * Anything this module cannot shard faithfully (another node:test export, a
 * case it cannot name, a duplicate name) marks the report unsupported, which
 * the runner also fails.
 */
const fs = require('fs');
const Module = require('module');

const count = Number(process.env.ATLAS_SHARD_COUNT);
const index = Number(process.env.ATLAS_SHARD_INDEX);
const reportFile = process.env.ATLAS_SHARD_REPORT;
const listOnly = process.env.ATLAS_SHARD_MODE === 'list';

if (Number.isInteger(count) && count >= 1 && Number.isInteger(index) && index >= 0 && index < count && reportFile) {
  const all = [];
  const ran = [];
  const problems = [];
  let wrapped = null;
  let touched = false;

  const nameOf = args => {
    const [first, second] = args;
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object' && typeof first.name === 'string') return first.name;
    if (typeof first === 'function' && first.name) return first.name;
    if (second && typeof second === 'object' && typeof second.name === 'string') return second.name;
    return null;
  };

  const load = Module._load;
  Module._load = function shardedLoad(request, ...rest) {
    const exported = load.call(this, request, ...rest);
    if (request !== 'node:test') return exported;
    touched = true;
    if (wrapped) return wrapped;
    wrapped = new Proxy(exported, {
      apply(target, thisArg, args) {
        const name = nameOf(args);
        const position = all.length;
        if (name === null) problems.push('unnamed case at ' + position);
        else if (all.includes(name)) problems.push('duplicate case name at ' + position);
        all.push(name === null ? '#' + position : name);
        if (position % count !== index || listOnly) return undefined;
        ran.push(all[position]);
        return Reflect.apply(target, thisArg, args);
      },
      get(target, property, receiver) {
        // Only the plain callable is supported. Anything else (describe, it,
        // skip, only, hooks, mock) would change which cases exist or run.
        if (typeof property === 'string' && property !== 'length' && property !== 'name' && property !== 'prototype') {
          problems.push('unsupported node:test member: ' + property);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    return wrapped;
  };

  process.on('exit', () => {
    if (!touched) return; // wrapper processes that never load node:test report nothing
    try {
      fs.writeFileSync(reportFile, JSON.stringify({ index, count, all, ran, problems, listOnly }), { mode: 0o600 });
    } catch { /* the runner treats a missing report as a failure */ }
  });
}
