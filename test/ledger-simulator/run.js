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

const { date, draw, monthDays, world } = require('./household');
const { build, generate, habits } = require('./habits');
const { faults } = require('./transport');
const { inspect, checks, known } = require('./oracle');
const { replay, display } = require('./replay');
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
function visibleRepro(seed, day, events, fault) {
  const input = world(seed, day, events);
  const selectedIds = new Set(events.flatMap((e) => e.rows.map((r) => r.id)));
  if (faults[fault]?.row || faults[fault]?.between)
    selectedIds.add(faults[fault]?.target?.(day) ?? 410000 + day);
  const rows = input.payload.transactions
    .filter((r) => selectedIds.has(r.id))
    .map((r) => ({
      id: r.id,
      date: r.date,
      account: r.plaid_account_id,
      amount: r.amount,
      category: r.category_id,
      payee: r.payee,
      ...(r.is_pending ? { pending: true } : {}),
      ...(r.notes ? { notes: r.notes } : {}),
      ...(r.tag_ids?.length ? { tagIds: r.tag_ids } : {}),
    }));
  const readableFault = fault
    ? {
        name: fault,
        day: date(day),
        ...(faults[fault].account ? { account: faults[fault].account } : {}),
        ...(faults[fault].row || faults[fault].between
          ? { target: faults[fault]?.target?.(day) ?? 410000 + day }
          : {}),
      }
    : undefined;
  return { rows, fault: readableFault };
}

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
    schema: 1,
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
      collect(c, output);
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
      const c = { seed, day, events, panel: name, baseline, knownOnly: true };
      const out = inspect({ ...c, view });
      // A changed result needs a current control and an exact historical
      // witness before the baseline can be reclassified as repaired.
      assert.ok(
        out.failures.some((f) => f.cause === cause),
        'COVERAGE: missing consensus witness for ' + name
      );
      collect(c, out);
    }
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
        const c = { seed, day, events };
        collect(c, inspect({ ...c, view: clean.view }));
        let pairPrior, pairControl;
        for (const [name, f] of Object.entries(faults)) {
          const sampled = draw(seed, name, day, 'fault') / 2 ** 32 < (opts.rates[name] ?? f.rate);
          // Fixed coverage of each single fault on a separate clean timeline,
          // in addition to stochastic exposures. Each fork starts at yesterday.
          const rotation = Object.keys(faults)[(day - 1) % Object.keys(faults).length];
          if (!sampled && (name !== rotation || opts.rates[name] === 0)) continue;
          if (!pairPrior) {
            const raw = { ...yesterday.raw };
            pairPrior = { raw, view: display(raw, null) };
            pairControl = display({ ...clean.raw }, raw);
          }
          const v = (await replay(seed, day, events, name, pairPrior.raw)).view;
          const pair = { ...c, fault: name };
          collect(pair, inspect({ ...pair, view: v, clean: pairControl, prior: pairPrior.view }));
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
        clean = await base(day);
      const v = (await replay(seed, day, [], name, prior.raw)).view;
      const c = { seed, day, events: [], fault: name, panel: 'qualified-fault' };
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
  // Several faults can challenge the same healthy reading. Reuse that
  // identical two-day control during reduction; final proofs are uncached.
  const pairs = new Map();
  async function controlPair(seed, day, events, force) {
    const key = JSON.stringify([
      seed,
      day,
      events.map((e) => [e.habit, e.start, e.rows.map((r) => [r.id, r.sync, r.pending])]),
    ]);
    if (!force && pairs.has(key)) return pairs.get(key);
    const prior = await replay(seed, day - 1, events);
    const clean = await replay(seed, day, events, null, prior.raw);
    const pair = { prior, clean };
    if (!force) {
      if (pairs.size >= 48) pairs.delete(pairs.keys().next().value);
      pairs.set(key, pair);
    }
    return pair;
  }
  for (const [key, { context: c, failure }] of candidates) {
    const cache = new Map();
    const all = tokensFor(c.events, c.day);
    async function test(tokens, force = false) {
      const key = tokens.join(',');
      if (!force && cache.has(key)) return cache.get(key);
      const events = subset(c.events, tokens);
      const runId = [c.seed, c.day, c.fault || '', c.panel || 'timeline', key].join(':');
      if (!force && sharedRuns.has(runId))
        return sharedRuns.get(runId).find((f) => signature(f) === signature(failure));
      const { prior, clean } = c.fault ? await controlPair(c.seed, c.day, events, force) : {};
      const v = (await replay(c.seed, c.day, events, c.fault, prior?.raw)).view;
      const foundAll = inspect({ ...c, events, view: v, clean: clean?.view, prior: prior?.view }).failures;
      if (!force) sharedRuns.set(runId, foundAll);
      const found = foundAll.find((f) => signature(f) === signature(failure));
      cache.set(key, found || false);
      return found;
    }
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
    const survivors = subset(c.events, kept);
    proofs.push({
      ...proof,
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
      ...visibleRepro(c.seed, c.day, survivors, c.fault),
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
  return result;
}
function family(cause) {
  if (
    (cause.startsWith('isolation/') && !cause.endsWith('unrelated-goal') && !cause.endsWith('thin-card')) ||
    cause === 'refresh/account-behind' ||
    cause === 'refresh/missing-balance'
  )
    return 'whole-refresh-fallback';
  if (cause.startsWith('last-known/retained')) return 'retained-figure-trust';
  if (/^purchase\/(pending-|fuel-preauth|cash-pending|savings-pending)/.test(cause))
    return 'pending-replacement-ownership';
  if (/^purchase\/(category-|paypal-transfer|studio-groceries|manual-row)/.test(cause))
    return 'spending-excluded-by-account-or-ledger-label';
  if (/^purchase\/savings-/.test(cause) || cause === 'savings/goal-tally')
    return 'savings-spending-attribution';
  return cause;
}
async function replayReport(file) {
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.schema, 1);
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
      const day = require('./household').offset(proof.day),
        fault = proof.fault?.name;
      const prior = fault ? await replay(proof.seed, day - 1, events) : null;
      const clean = fault ? await replay(proof.seed, day, events, null, prior.raw) : null;
      const view = (await replay(proof.seed, day, events, fault, prior?.raw)).view;
      const baseline =
        known.includes(proof.cause) || proof.panel.startsWith('inventory/')
          ? (await replay(proof.seed, day, [])).view
          : null;
      const output = inspect({
        seed: proof.seed,
        day,
        events,
        view,
        fault,
        clean: clean?.view,
        prior: prior?.view,
        baseline,
      });
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
module.exports = { run, options, panel };
