'use strict';
// Item c (#822): a page load that replays the retained observation reuses the
// result already computed for exactly the same inputs, instead of running
// Forecast again. Synthetic inputs only: loopback provider, invented fixture,
// real workers. No household file, credential or provider write.
const threads = require('node:worker_threads');

// Worker-only preload (#1162 Atlas blocker class): the result depends on a
// test-owned invented file read from disk during the run, standing in for any
// disk dependency such as public/periods.json. Never loaded by the main suite.
if (!threads.isMainThread && process.env.ATLAS_SYNTHETIC_WITNESS_FILE) {
  // Captured before the recorder wraps fs: a descriptor it returns comes from
  // no recorded open.
  const unrecordedOpen = require('node:fs').openSync;
  const Live = require('../scripts/live-plan'), apply = Live.applyForServer;
  Live.applyForServer = async (...args) => {
    const fs = require('node:fs'), file = process.env.ATLAS_SYNTHETIC_WITNESS_FILE;
    const mode = process.env.ATLAS_SYNTHETIC_WITNESS_MODE;
    // Read through the live fs functions, as the planner modules do.
    // 'realpath': the dependency is only which file a link resolves to.
    // 'descriptor': read through a descriptor no recorded open returned.
    const witness = mode === 'realpath' ? require('node:path').basename(fs.realpathSync(file))
      : mode === 'descriptor' ? fs.readFileSync(unrecordedOpen(file, 'r'), 'utf8')
        : fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    // A touch the recorder cannot attribute to a path must never be reused.
    if (process.env.ATLAS_SYNTHETIC_WITNESS_UNATTRIBUTED === '1') fs.existsSync(new URL('http://invented.example/not-a-file'));
    const data = await apply(...args);
    return { ...data, syntheticWitness: witness };
  };
} else if (threads.isMainThread) {
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { provider, environment, CLOCK } = require('./test-server-observation-memory');
const Fixture = require('./fixtures/budget-surface-data');

const workers = [], exits = [], witnesses = [];
const RealWorker = threads.Worker;
threads.Worker = class extends RealWorker {
  constructor(...args) { super(...args); workers.push(this); exits.push(new Promise(resolve => this.once('exit', resolve))); }
  emit(event, value, ...args) {
    // Observe (never alter) the disk witness each replay worker reports.
    if (event === 'message' && value && Object.hasOwn(value, 'reads')) witnesses.push(value.reads);
    return super.emit(event, value, ...args);
  }
};
const Refresh = require('../scripts/server-live-refresh');
const Live = require('../scripts/live-plan');

(async () => {
  const originalNow = Date.now, originalLog = console.log;
  let now = CLOCK, checks = 0;
  Date.now = () => Date.parse(now);
  const lines = [];
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('{"type":"live-refresh-')) lines.push(JSON.parse(args[0]));
    else originalLog(...args);
  };
  const check = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
  const drain = () => Promise.all(exits);
  const mock = await provider(), env = environment(mock.base);
  const canonical = Fixture.canonical();
  // Each step counts the workers (Forecast runs) and provider GETs it caused.
  async function load(input, options, label, useEnv = env) {
    const w = workers.length, calls = mock.calls.length, started = performance.now();
    let seen;
    const data = await Refresh.serve(input, useEnv, { preferObservation: true, ...options, onCheck(value) { seen = value; } });
    const ms = performance.now() - started;
    await drain();
    return { data, check: seen, workers: workers.length - w, calls: mock.calls.length - calls, ms, label };
  }
  try {
    // Independent reference: the same evidence evaluated directly, no lifecycle.
    let observation;
    const direct = await Live.applyForServer(canonical, env, { onObservation(value) { observation = value; } });
    check(observation.qualified, true, 'synthetic live observation qualifies');

    const live = await load(canonical, {}, 'first load');
    check(live.data, direct, 'first load equals independent evaluation');
    check([live.workers, live.calls > 0], [1, true], 'first load computes once from the provider');

    // Two concurrent first replays share one worker: one Forecast run.
    const w0 = workers.length, c0 = mock.calls.length;
    const [a, b] = await Promise.all([Refresh.serve(canonical, env, { preferObservation: true }),
      Refresh.serve(canonical, env, { preferObservation: true })]);
    await drain();
    check(a, direct, 'first replay equals independent evaluation');
    check(b, direct, 'joined first replay equals independent evaluation');
    check(workers.length - w0, 1, 'concurrent first replays share one worker');
    check(mock.calls.length - c0, 0, 'replay makes no provider request');

    // Identical inputs: no worker, no provider request, same publication.
    const hit = await load(canonical, {}, 'identical replay');
    check(hit.workers, 0, 'identical inputs do not recompute');
    check(hit.calls, 0, 'identical inputs make no provider request');
    check(hit.data, direct, 'reused result equals independent evaluation');
    check(hit.check, { source: 'memory', qualified: true, checkedAt: CLOCK }, 'reused result keeps the original check');
    hit.data.plan.startingCash.breakdown[0].value = 99999;
    const again = await load(canonical, {}, 'replay after caller mutation');
    check([again.workers, again.data], [0, direct], 'callers never share the remembered object');
    const reuseLines = lines.filter(line => line.type === 'live-refresh-reuse');
    check(reuseLines.length, 2, 'each reuse is logged once');
    check(reuseLines.every(line => Object.keys(line).sort().join() === 'outcome,totalMs,type'), true,
      'reuse log holds closed fields only');
    // Timings (keys ending Ms) are durations, not figures; a duration can
    // contain the digits by chance.
    check(lines.some(line => JSON.stringify(line, (key, value) => /Ms$/.test(key) ? undefined : value)
      .includes('1215')), false, 'no figure reaches the log');

    // Forced refresh never reuses: it always asks the provider.
    const forced = await load(canonical, { forceRefresh: true }, 'forced refresh');
    check([forced.workers, forced.calls > 0], [1, true], 'forced refresh recomputes from the provider');
    const afterForce = await load(canonical, {}, 'replay after forced refresh');
    check(afterForce.workers, 1, 'a new observation epoch recomputes once');
    check((await load(canonical, {}, 'reuse restored')).workers, 0, 'then reuses again');

    // Changed observation: a new provider answer is new evidence.
    const changed = { ...Fixture.payload(), tags: [] };
    changed.accounts[0].balance = String(Number(changed.accounts[0].balance) + 40);
    mock.payload(changed);
    const newLive = await load(canonical, { forceRefresh: true }, 'new observation');
    const newReplay = await load(canonical, {}, 'replay of new observation');
    check(newReplay.workers, 1, 'changed observation recomputes');
    check(newReplay.data, newLive.data, 'replay serves the new observation');
    assert.notDeepEqual(newReplay.data, direct, 'old remembered result is never served for new evidence'); checks++;
    check((await load(canonical, {}, 'reuse of new observation')).data, newLive.data, 'reuse follows the new observation');
    mock.payload({ ...Fixture.payload(), tags: [] });
    await load(canonical, { forceRefresh: true }, 'restore observation');

    // Changed plan: a different canonical input is a different key.
    const plan = structuredClone(canonical);
    plan.plan.budget.categories[0].target = Number(plan.plan.budget.categories[0].target || 0) + 25;
    const planLoad = await load(plan, {}, 'changed plan');
    check(planLoad.workers, 1, 'changed plan recomputes');
    check((await load(plan, {}, 'changed plan replay')).workers, 1, 'first replay of changed plan recomputes');
    check((await load(plan, {}, 'changed plan reuse')).workers, 0, 'changed plan then reuses its own result');
    check((await load(canonical, {}, 'original plan')).workers, 1, 'returning to the old plan recomputes');

    // Changed household day: never served across midnight.
    await load(canonical, {}, 'replay before midnight');
    check((await load(canonical, {}, 'reuse before midnight')).workers, 0, 'same day reuses');
    now = new Date(Date.parse(CLOCK) + 24 * 3600 * 1000).toISOString();
    const nextDay = await load(canonical, {}, 'next household day');
    check(nextDay.workers, 1, 'next household day recomputes');
    now = CLOCK;
    check((await load(canonical, {}, 'back to first day')).workers, 1, 'returning to the earlier day recomputes');

    // Changed engine version: the loaded engine files (paths and revisions)
    // are part of the key. Loading one more repository module changes that
    // set without touching any shared file another suite may be reading.
    await load(canonical, {}, 'replay before engine change');
    check((await load(canonical, {}, 'reuse before engine change')).workers, 0, 'same engine reuses');
    const extra = require.resolve('../scripts/figures-comment');
    assert.equal(Object.hasOwn(require.cache, extra), false, 'extra module starts unloaded'); checks++;
    require(extra);
    try {
      check((await load(canonical, {}, 'engine changed')).workers, 1, 'changed engine version recomputes');
      check((await load(canonical, {}, 'changed engine replay')).workers, 1, 'first replay under the new engine recomputes');
    } finally { delete require.cache[extra]; }
    check((await load(canonical, {}, 'engine restored')).workers, 1, 'returning to the earlier engine recomputes');

    // A provider write invalidates everything remembered.
    await load(canonical, {}, 'replay before write');
    check((await load(canonical, {}, 'reuse before write')).workers, 0, 'reuse before a write');
    await Refresh.withProviderWrite(async () => {});
    const afterWrite = await load(canonical, {}, 'after write');
    check([afterWrite.workers, afterWrite.calls > 0], [1, true], 'after a write the next load asks the provider');

    // Disk dependencies (#1162 Atlas blocker): every file a replay reads is
    // witnessed by its revision; any change, removal or unattributable read
    // recomputes. A real replay's witness names public/periods.json.
    const root = path.resolve(__dirname, '..');
    const realWitness = witnesses.filter(Array.isArray).at(-1);
    check(realWitness.some(entry => entry[0] === path.join(root, 'public', 'periods.json')), true,
      'replay witness includes public/periods.json');
    check(realWitness.every(entry => Array.isArray(entry) && entry.length <= 7
      && entry.every(part => typeof part === 'string' && part.length < 4096)), true,
    'witness holds paths and revisions only, never file contents');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-replay-witness-'));
    const file = path.join(tmp, 'invented-dependency.txt');
    const preload = '--require "' + __filename.replace(/\\/g, '/') + '"';
    const diskEnv = { ...env, NODE_OPTIONS: preload, ATLAS_SYNTHETIC_WITNESS_FILE: file };
    try {
      fs.writeFileSync(file, 'invented-v1');
      await load(canonical, { forceRefresh: true }, 'disk setup', diskEnv);
      check((await load(canonical, {}, 'disk replay', diskEnv)).workers, 1, 'disk-dependent replay computes once');
      const diskHit = await load(canonical, {}, 'disk reuse', diskEnv);
      check([diskHit.workers, diskHit.data.syntheticWitness], [0, 'invented-v1'], 'unchanged disk dependency reuses');
      fs.writeFileSync(file, 'invented-v2');
      const changedDisk = await load(canonical, {}, 'disk changed', diskEnv);
      check([changedDisk.workers, changedDisk.data.syntheticWitness], [1, 'invented-v2'],
        'changed disk dependency recomputes and serves the current file');
      check((await load(canonical, {}, 'disk changed reuse', diskEnv)).data.syntheticWitness, 'invented-v2',
        'reuse follows the current file');
      // A change between a reuse starting and its publication (#1162 second
      // Atlas finding): caller A takes the remembered result, the file
      // changes, caller B joins before publication. Neither may get the
      // remembered result; both get one fresh compute of the current file.
      check((await load(canonical, {}, 'race primed', diskEnv)).workers, 0, 'race starts from a remembered result');
      const raceWorkers = workers.length;
      const first = Refresh.serve(canonical, diskEnv, { preferObservation: true });
      fs.writeFileSync(file, 'invented-v3');
      const joined = Refresh.serve(canonical, diskEnv, { preferObservation: true });
      const [raceA, raceB] = await Promise.all([first, joined]);
      await drain();
      check([raceA.syntheticWitness, raceB.syntheticWitness], ['invented-v3', 'invented-v3'],
        'a dependency change before publication is never served stale, including to a joining caller');
      check(workers.length - raceWorkers, 1, 'the joined callers share one fresh compute');
      check((await load(canonical, {}, 'race settled', diskEnv)).data.syntheticWitness, 'invented-v3',
        'reuse resumes on the current file');
      fs.rmSync(file);
      const removed = await load(canonical, {}, 'disk removed', diskEnv);
      check([removed.workers, removed.data.syntheticWitness], [1, null], 'removed disk dependency recomputes');
      const unattributed = { ...diskEnv, ATLAS_SYNTHETIC_WITNESS_UNATTRIBUTED: '1' };
      await load(canonical, { forceRefresh: true }, 'unattributed setup', unattributed);
      check((await load(canonical, {}, 'unattributed replay', unattributed)).workers, 1, 'unattributed read computes');
      check((await load(canonical, {}, 'unattributed again', unattributed)).workers, 1,
        'a replay with an unattributable read is never reused');
      // A read only through realpath (or readlink, statfs, watch) is
      // witnessed: re-pointing the link recomputes.
      const targetA = path.join(tmp, 'invented-target-a'), targetB = path.join(tmp, 'invented-target-b');
      fs.writeFileSync(targetA, 'a'); fs.writeFileSync(targetB, 'b');
      fs.symlinkSync(targetA, file);
      const linked = { ...diskEnv, ATLAS_SYNTHETIC_WITNESS_MODE: 'realpath' };
      await load(canonical, { forceRefresh: true }, 'realpath setup', linked);
      check((await load(canonical, {}, 'realpath replay', linked)).data.syntheticWitness, 'invented-target-a',
        'realpath dependency computes');
      check((await load(canonical, {}, 'realpath reuse', linked)).workers, 0, 'unchanged link reuses');
      fs.rmSync(file); fs.symlinkSync(targetB, file);
      const repointed = await load(canonical, {}, 'realpath changed', linked);
      check([repointed.workers, repointed.data.syntheticWitness], [1, 'invented-target-b'],
        'a re-pointed link recomputes and serves the current target');
      // A descriptor no recorded open returned names no path: never reused.
      fs.rmSync(file); fs.writeFileSync(file, 'invented-fd');
      const described = { ...diskEnv, ATLAS_SYNTHETIC_WITNESS_MODE: 'descriptor' };
      await load(canonical, { forceRefresh: true }, 'descriptor setup', described);
      check((await load(canonical, {}, 'descriptor replay', described)).workers, 1, 'descriptor read computes');
      check((await load(canonical, {}, 'descriptor again', described)).workers, 1,
        'a replay that reads through an unrecorded descriptor is never reused');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

    // Timing on the invented fixture: a replay that computes, then a reuse.
    await load(canonical, { forceRefresh: true }, 'timing setup');
    const timedMiss = await load(canonical, {}, 'timed replay');
    const timedHit = await load(canonical, {}, 'timed reuse');
    check([timedMiss.workers, timedHit.workers], [1, 0], 'timing pair is one compute then one reuse');
    originalLog('MEASURED ' + JSON.stringify({ replayComputeMs: Math.round(timedMiss.ms), replayReuseMs: Math.round(timedHit.ms),
      fixture: 'test/fixtures/budget-surface-data (invented)' }));
    originalLog('PASS replay result reuse: ' + checks + ' checks; identical inputs reuse, changed observation/plan/day/engine/disk file/write recompute');
  } finally {
    console.log = originalLog; Date.now = originalNow;
    await mock.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
}
