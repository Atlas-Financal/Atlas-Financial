'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// Fail closed on a future implicit dependency on household files. The harness
// has its own no-periods shim. The simulator supplies every map and identity.
const root = path.resolve(__dirname, '../..');
const read = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  if (typeof file === 'string') {
    const rel = path.relative(root, path.resolve(file)).replaceAll('\\', '/').toLowerCase();
    if (
      /^(raw\/|derived\/|snapshots\/|data\.json$|\.env(?:\.|$)|docs\/connectivity\/.*\.json$|public\/(?:periods|balance-history)\.json$)/.test(
        rel
      )
    )
      throw Error('Simulator attempted to read household inputs');
  }
  return read.call(this, file, ...args);
};

const { date, draw, monthDays } = require('./household');
const { build, generate, habits } = require('./habits');
const { faults } = require('./transport');
const { inspect, checks, known } = require('./oracle');
const { replay, digest } = require('./replay');
const { evaluate, observationReader } = require('./witness');
const { tokensFor, subset, shrink } = require('./shrink');
const { workedControls } = require('./worked');
const { inventory } = require('./inventory');
const panel = {
  'topup-late': 'topup',
  'topup-pending': 'topup',
  'line-payment': 'line-payment',
  'equal-card': 'equal-card',
  'bill-renamed': 'bill',
  'bill-weekly': 'bill',
  'bill-above': 'bill',
  'subscription-paypal': 'bill',
  shopping: 'shopping',
  'near-minimum': 'false-minimum',
};
const allRates = { ...habits, ...faults };
function options(argv) {
  const opts = { seeds: 1, months: 1, seed: 173, rates: {}, mode: 'campaign' };
  const take = (i) => {
    if (i >= argv.length) throw Error('Missing option value');
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') opts.mode = 'list';
    else if (['--advisory', '--known-six', '--controls'].includes(arg)) opts.mode = arg.slice(2);
    else if (arg === '--replay-report') opts.replayReport = take(++i);
    else if (arg === '--output') opts.output = take(++i);
    else if (['--seed', '--seeds', '--months'].includes(arg)) {
      const value = Number(take(++i));
      assert.ok(Number.isSafeInteger(value) && value >= (arg === '--seed' ? 0 : 1), 'invalid ' + arg);
      opts[arg.slice(2)] = value;
    } else if (arg === '--rate') {
      const [key, value, ...extra] = take(++i).split('=');
      const n = Number(value);
      assert.ok(
        Object.hasOwn(allRates, key) && value?.length && !extra.length && n >= 0 && n <= 1,
        'invalid frequency dial'
      );
      opts.rates[key] = n;
    } else throw Error('Unknown option ' + arg);
  }
  return opts;
}
const increment = (map, key, n = 1) => {
  map[key] = (map[key] || 0) + n;
};
function signature(f) {
  const effect = Number.isSafeInteger(f.expected)
    ? f.actual == null
      ? 'withheld'
      : f.actual < f.expected
        ? 'too-low'
        : 'too-high'
    : Array.isArray(f.expected) && f.cause.startsWith('last-known/')
      ? [
          f.actual[0] == null ? 'unknown' : f.actual[0] === f.expected[0] ? 'same' : 'changed',
          f.actual[1],
        ].join('/')
      : f.check;
  return [f.cause, f.figure, f.habit, effect].join('|');
}
const cost = (c) => tokensFor(c.events, c.day).length;
async function run(opts) {
  if (opts.mode === 'list')
    return Object.fromEntries(
      Object.entries(allRates).map(([name, h]) => [
        name,
        {
          rate: h.rate,
          label: name.startsWith('category-')
            ? require('./household').labels.find(
                (l) => require('./household').ids[l] === Number(name.slice(9))
              )
            : undefined,
        },
      ])
    );
  const modes = opts.mode,
    advisory = modes === 'advisory';
  const seeds = advisory ? [73] : Array.from({ length: opts.seeds }, (_, i) => opts.seed + i);
  const days = advisory ? 7 : monthDays(opts.months);
  const stats = {
    dailyReads: 0,
    qualifiedDays: 0,
    pairedFaults: 0,
    yesterdayControls: 0,
    exercised: {},
    habits: {},
    faults: {},
  };
  const candidates = new Map(),
    counts = new Map();
  function collect(c, checksResult) {
    for (const name of checksResult.exercised) increment(stats.exercised, name);
    for (const f of checksResult.failures) {
      const k = signature(f),
        entry = counts.get(k) || { seeds: new Set(), samples: new Set() };
      entry.seeds.add(c.seed);
      entry.samples.add([c.seed, c.day, c.fault || '', c.panel || 'timeline'].join('/'));
      counts.set(k, entry);
      if (!candidates.has(k) || cost(c) < cost(candidates.get(k).context))
        candidates.set(k, { context: c, failure: f });
    }
  }
  const result = {
    schema: 2,
    mode: modes,
    seeds,
    days: modes === 'known-six' ? 0 : days,
    rates: opts.rates,
    stats,
  };
  result.controls = await workedControls();
  if (modes === 'controls') return result;
  if (modes === 'campaign')
    result.inventory = await inventory(seeds[0], (c, view) => {
      const output = inspect({ ...c, view });
      collect({ ...c, firstDay: c.day, baselineDay: c.day }, output);
    });
  for (const seed of seeds) {
    const bases = new Map();
    async function base(day) {
      if (!bases.has(day)) bases.set(day, await replay(seed, day, []));
      return bases.get(day);
    }
    for (const [name, cause] of Object.entries(panel)) {
      const day = name === 'equal-card' ? 5 : 3,
        events = [build(seed, name, 3)];
      const baseline = (await base(day)).view;
      assert.ok(baseline.qualified && numericBaseline(baseline), 'known-six control must publish');
      const view = (await replay(seed, day, events)).view;
      const c = {
        seed,
        day,
        firstDay: day,
        baselineDay: day,
        events,
        panel: name,
        baseline,
        knownOnly: true,
      };
      const out = inspect({ ...c, view });
      // A changed result needs a current control and an exact historical
      // witness before the baseline can be reclassified as repaired.
      assert.ok(
        out.failures.some((f) => f.cause === cause),
        'COVERAGE: missing consensus witness for ' + name
      );
      collect(c, out);
    }
    const historical = {
      seed,
      day: 5,
      firstDay: 3,
      baselineDay: 4,
      panel: 'retained-pending-topup',
      events: [build(seed, 'topup-pending', 3)],
      fault: 'missing-balance',
      knownOnly: true,
    };
    const retained = await evaluate(historical, historical.events);
    assert.ok(
      retained.failures.some((f) => f.cause === 'topup'),
      'missing retained prior-row witness'
    );
    collect(historical, retained);
    if (modes === 'known-six') continue;
    const journal = generate(seed, days, opts.rates);
    for (const e of journal) {
      increment(stats.habits, e.habit);
      if (!Object.hasOwn(panel, e.habit)) continue;
      const day = e.start + (e.habit === 'equal-card' ? 2 : 0);
      if (day > days) continue;
      const c = {
        seed,
        day,
        events: [e],
        firstDay: day,
        baselineDay: day,
        panel: 'sampled/' + e.habit,
        baseline: (await base(day)).view,
        knownOnly: true,
      };
      const view = (await replay(seed, day, [e])).view;
      collect(c, inspect({ ...c, view }));
    }
    let yesterday = null;
    for (let day = 0; day <= days; day++) {
      const events = journal.filter((e) => e.start <= day);
      const clean = await replay(seed, day, events, null, yesterday?.raw);
      if (day > 0) {
        stats.dailyReads++;
        if (clean.view.qualified) stats.qualifiedDays++;
        const c = { seed, day, events, firstDay: 0 };
        collect(c, inspect({ ...c, view: clean.view, prior: yesterday.view }));
        for (const [name, f] of Object.entries(faults)) {
          const sampled = draw(seed, name, day, 'fault') / 2 ** 32 < (opts.rates[name] ?? f.rate);
          // Fixed coverage of each single fault on a separate clean timeline,
          // in addition to stochastic exposures. Each fork starts at yesterday.
          const rotation = Object.keys(faults)[(day - 1) % Object.keys(faults).length];
          if (!sampled && (name !== rotation || opts.rates[name] === 0)) continue;
          const v = (await replay(seed, day, events, name, yesterday.raw)).view;
          const pair = { ...c, fault: name, panel: sampled ? 'timeline' : 'rotation' };
          collect(pair, inspect({ ...pair, view: v, clean: clean.view, prior: yesterday.view }));
          stats.pairedFaults++;
          increment(stats.faults, name);
          if (yesterday?.raw.qualified) stats.yesterdayControls++;
        }
      }
      yesterday = clean;
    }
    for (const name of Object.keys(faults)) {
      const day = 5,
        prior = await base(4),
        clean = await replay(seed, day, [], null, prior.raw);
      const v = (await replay(seed, day, [], name, prior.raw)).view;
      const c = { seed, day, firstDay: 4, events: [], fault: name, panel: 'qualified-fault' };
      collect(c, inspect({ ...c, view: v, clean: clean.view, prior: prior.view }));
      stats.pairedFaults++;
      stats.yesterdayControls++;
      increment(stats.faults, name);
    }
  }
  if (modes !== 'known-six') {
    assert.equal(stats.dailyReads, seeds.length * days, 'partial daily replay');
    for (const check of checks) assert.ok(stats.exercised[check] > 0, 'unexercised invariant ' + check);
  }
  const proofs = [];
  const sharedRuns = new Map();
  const read = observationReader();
  for (const [key, { context: c, failure }] of candidates) {
    const cache = new Map();
    const all = tokensFor(c.events, c.day);
    async function test(tokens, force = false) {
      const key = tokens.join(',');
      if (!force && cache.has(key)) return cache.get(key);
      const events = subset(c.events, tokens);
      const runId = JSON.stringify([
        c.seed,
        c.firstDay,
        c.day,
        c.fault,
        c.priorFaults,
        c.baselineDay,
        c.knownOnly,
        c.panel,
        c.events.map((e) => [e.habit, e.start]),
        key,
      ]);
      if (!force && sharedRuns.has(runId))
        return sharedRuns.get(runId).find((f) => signature(f) === signature(failure));
      const evaluated = await evaluate(c, events, force ? undefined : read, force);
      const foundAll = evaluated.failures;
      if (!force) sharedRuns.set(runId, foundAll);
      const found = foundAll.find((f) => signature(f) === signature(failure));
      cache.set(key, found || false);
      return force && found
        ? { finding: found, observations: evaluated.observations, rows: evaluated.rows }
        : found;
    }
    const original = await test(all);
    assert.deepEqual(original, failure, 'complete original recipe must replay its recorded outcome: ' + key);
    let start = all;
    const related = all.filter((t) => c.events[Number(t.split('/')[0])].habit === failure.habit);
    if (await test([])) start = [];
    else if (related.length && related.length < all.length && (await test(related))) start = related;
    else if (c.fault && all.length > 6) {
      const recent = all.filter((t) => {
        const e = c.events[Number(t.split('/')[0])];
        return e.start >= c.day - 1 || e.rows.some((r) => r.sync === c.day || r.until === c.day);
      });
      if (recent.length && recent.length < all.length && (await test(recent))) start = recent;
    }
    const { kept, proof } = await shrink(start, test).catch((err) => {
      throw new Error(
        key +
          ' seed ' +
          c.seed +
          ' day ' +
          c.day +
          ' ' +
          (c.fault || '') +
          ' ' +
          (c.panel || '') +
          ': ' +
          err.message,
        { cause: err }
      );
    });

    proofs.push({
      ...proof.finding,
      reads: proof.observations,
      rows: proof.rows,
      firstDay: c.firstDay,
      ...(c.baselineDay != null ? { baselineDay: c.baselineDay } : {}),
      ...(c.priorFaults ? { priorFaults: c.priorFaults } : {}),
      knownOnly: Boolean(c.knownOnly),
      ...(c.fault ? { fault: { name: c.fault, day: date(c.day) } } : {}),
      seed: c.seed,
      day: date(c.day),
      panel: c.panel || 'timeline',
      seeds: counts.get(key).seeds.size,
      observations: counts.get(key).samples.size,
      inputCount: all.length,
      kept: kept.length,
      operations: c.events
        .map((e, i) => ({
          habit: e.habit,
          start: e.start,
          selected: kept.filter((t) => Number(t.split('/')[0]) === i).map((t) => t.split('/')[1]),
        }))
        .filter((e) => e.selected.length),
    });
  }
  const groups = new Map();
  for (const p of proofs) {
    const key = family(p.cause),
      g = groups.get(key) || { cause: key, seeds: new Set(), samples: new Set(), witnesses: [] };
    const cnt = counts.get(signature(p));
    for (const s of cnt.seeds) g.seeds.add(s);
    for (const s of cnt.samples) g.samples.add(s);
    g.witnesses.push(p);
    groups.set(key, g);
  }
  const ranked = [...groups.values()]
    .map((g) => ({
      cause: g.cause,
      seeds: g.seeds.size,
      observations: g.samples.size,
      sampledSeedCount: new Set(
        [...g.samples]
          .filter((s) => s.endsWith('/timeline') || s.includes('/sampled/'))
          .map((s) => s.split('/')[0])
      ).size,
      sampledObservations: [...g.samples].filter((s) => s.endsWith('/timeline') || s.includes('/sampled/'))
        .length,
      witnesses: g.witnesses.sort(
        (a, b) => a.rows.length - b.rows.length || a.habit.localeCompare(b.habit, 'en')
      ),
    }))
    .sort(
      (a, b) =>
        b.sampledSeedCount - a.sampledSeedCount ||
        b.sampledObservations - a.sampledObservations ||
        b.seeds - a.seeds ||
        b.observations - a.observations ||
        a.cause.localeCompare(b.cause, 'en')
    );
  result.consensus = ranked.filter((r) => known.includes(r.cause));
  result.additional = ranked.filter((r) => !known.includes(r.cause));
  assert.equal(result.consensus.length, 6, 'partial known-six coverage');
  result.reportId = digest(result);
  return result;
}
function family(cause) {
  if (cause.startsWith('admission/')) return 'invalid-refresh-admission';
  if (cause.startsWith('retention/')) return 'retained-cohort-mismatch';
  if (/^purchase\/(pending-|fuel-preauth|cash-pending|savings-pending)/.test(cause))
    return 'pending-replacement-ownership';
  if (cause.startsWith('classification/')) return 'ledger-classification';
  if (/^purchase\/savings-/.test(cause) || cause === 'savings/goal-tally')
    return 'savings-spending-attribution';
  return cause;
}
async function replayReport(file) {
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.schema, 2, 'schema 2 history-bound report required');
  const { reportId, ...contents } = saved;
  assert.equal(reportId, digest(contents), 'report identity mismatch');
  assert.deepEqual(
    saved.consensus.map((g) => g.cause).sort(),
    [...known].sort(),
    'incomplete consensus report'
  );
  let verified = 0;
  for (const group of [...saved.consensus, ...saved.additional])
    for (const proof of group.witnesses) {
      const events = proof.operations.flatMap((op) =>
        subset(
          [build(proof.seed, op.habit, op.start)],
          op.selected.map((n) => '0/' + n)
        )
      );
      const day = require('./household').offset(proof.day);
      assert.ok(Number.isInteger(proof.firstDay) && proof.firstDay >= 0 && proof.firstDay <= day);
      const c = { ...proof, day, fault: proof.fault?.name };
      const output = await evaluate(c, events, undefined, true);
      assert.deepEqual(output.observations, proof.reads, 'historical input or qualification mismatch');
      assert.deepEqual(
        output.rows,
        proof.rows,
        'serialized witness row versions differ from the actual reads'
      );
      const found = output.failures.find((f) => signature(f) === signature(proof));
      assert.ok(found, 'lost witness ' + signature(proof));
      assert.deepEqual([found.expected, found.actual], [proof.expected, proof.actual]);
      verified++;
    }
  assert.ok(verified > 0, 'empty report');
  return { verified };
}
function numericBaseline(v) {
  return Number.isInteger(v.amounts.bad) && Number.isInteger(v.amounts.billsEnd);
}
if (require.main === module)
  (async () => {
    const opts = options(process.argv.slice(2)),
      started = performance.now();
    const result = opts.replayReport ? await replayReport(opts.replayReport) : await run(opts),
      report = JSON.stringify(result, null, 2) + '\n';
    if (opts.output) fs.writeFileSync(opts.output, report);
    else process.stdout.write(report);
    console.error('Completed in ' + ((performance.now() - started) / 1000).toFixed(1) + ' seconds.');
  })().catch((err) => {
    console.error('HARNESS OR COVERAGE FAILURE', err.stack);
    process.exitCode = 2;
  });
module.exports = { run, options, panel, replayReport };
