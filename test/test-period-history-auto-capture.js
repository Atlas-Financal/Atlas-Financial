'use strict';
// Period-close capture at rollover (ARCHITECTURE.md "Period-close capture").
// Invented households only; no data.json, no live credential, no archive.
// The fake clock drives ticks; a fake archive records reads and appends; a
// loopback provider counts every HTTP request and its method, so the number
// of provider reads per period, per day and across simulated restarts is
// asserted directly.
const assert = require('node:assert/strict');
const http = require('node:http');
const Auto = require('../scripts/period-history-auto-capture');
const SessionGate = require('../scripts/period-history-session-gate');
const Capture = require('../scripts/period-history-refresh-capture');
const Fixture = require('./fixtures/budget-surface-data');

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ON = { [Auto.FLAG]: 'on', [Capture.FLAG]: 'on' };
const MIN = 60 * 1000;
const at = iso => Date.parse(iso);

// Biweekly invented plan anchored 2030-02-01: 02-01..02-14, 02-15..02-28.
const START = '2030-02-01', END = '2030-02-14';
const WS = '2030-02-15T08:00:00.000Z', WS2 = '2030-02-15T12:00:00.000Z'; // two window openings
function invented(day) {
  const ids = ['chequing-a', 'chequing-b', 'savings'];
  const cash = ids.map((id, i) => ({ id, label: 'Invented cash ' + i, value: [1000, 500, 100][i], evidenceDate: day, confidence: 'confirmed' }));
  return {
    periods: [],
    data: { meta: { asOf: day }, accounts: [], debts: [], revolvingExtra: [], plan: {
      opening: { asOf: day, representedEvents: [] }, startingCash: { breakdown: cash },
      defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
      income: [{ id: 'payroll', label: 'Invented income', frequency: 'biweekly', anchor: START, amount: 200, confidence: 'confirmed' }],
      bills: [], commitments: [], obligations: [], groups: [], funding: { options: [] },
      budget: { categories: [['groceries', 40], ['fuel', 15], ['restaurants', 10], ['dale-guilt-free', 5],
        ['amanda-guilt-free', 5], ['pets', 5], ['other-spend', 20]].map(([id, plannedPayday]) =>
        ({ id, label: 'Invented ' + id, plannedPayday, class: 'essential', confidence: 'confirmed', from: [] })) },
    } },
    accountMap: { provider: 'lunchmoney', schema: 'atlas-provider-account-map/v1', scope: 'owner-observed', mappings: ids.map((id, i) =>
      ({ providerAccountId: 'invented-account-' + i, atlasRole: 'household-cash', canonical: { id, collection: 'cash' } })) },
    identity: { rules: [], billPaymentPayees: [] },
    payload: { provider: 'lunchmoney', fetchedAt: day + 'T18:00:00Z',
      accounts: cash.map((row, i) => ({ id: 'invented-account-' + i, name: 'Invented provider cash ' + i,
        currency: 'cad', balance: row.value, balance_as_of: day + 'T17:59:00Z', updated_at: day + 'T17:59:00Z' })),
      categories: [{ id: 'invented-category', name: 'Groceries' }], tags: [],
      transactions: [{ id: 'invented-transaction', account_id: 'invented-account-1', date: START, amount: '12.34', currency: 'cad',
        category_id: 'invented-category', payee: 'Invented Market', original_name: 'INVENTED MARKET SOURCE',
        is_pending: false, updated_at: day + 'T17:58:00Z' }],
      transactionWindow: { startDate: START, endDate: day, complete: true, hasMore: false, truncated: false },
      pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false },
    },
  };
}
function archive(rows = [], { limitOne = false } = {}) {
  const state = { rows: [...rows], reads: 0, appends: [], opened: 0, retired: 0, conflict: false, active: 0, sessions: [], claims: new Set(), claimCalls: 0 };
  const unavailable = () => { const e = new Error('history-store-unavailable'); e.code = e.message; return e; };
  state.open = async () => {
    // CONNECTION LIMIT 1: a second session is refused while one is open.
    if (limitOne && state.active) throw unavailable();
    state.opened++; state.active++;
    // Like the connection owner: loss notifies watchers synchronously, then
    // the connection is released; a lost session refuses every operation.
    const session = { lost: false, watchers: new Set(), released: false };
    const release = () => { if (!session.released) { session.released = true; state.active--; } };
    session.lose = () => { if (session.lost) return; session.lost = true; for (const w of session.watchers) w(); session.watchers.clear(); release(); };
    state.sessions.push(session);
    return { onLoss: fn => { if (session.lost) { fn(); return () => {}; } session.watchers.add(fn); return () => session.watchers.delete(fn); },
      // capture_window_claims: primary key across every session and instance.
      claimWindow: async ({ periodStart, periodEnd, windowStart }) => {
        if (session.lost) throw unavailable(); state.claimCalls++;
        const key = windowStart; // PRIMARY KEY (window_start): one claim per window, whatever period an instance names
        if (state.claims.has(key)) return false; state.claims.add(key); return true; },
      read: async () => { if (session.lost) throw unavailable(); state.reads++; if (state.onRead) state.onRead(session); if (session.lost) throw unavailable(); return state.rows.map(r => ({ ...r })); },
      append: async ({ candidate }) => {
        if (session.lost) throw unavailable();
        if (state.conflict) { const e = new Error('history-original-or-closing-conflict'); e.code = e.message; throw e; }
        state.appends.push(candidate);
        state.rows.push({ kind: candidate.content.kind, period: candidate.content.period });
        return { status: 'appended' };
      },
      retire: async () => { state.retired++; session.lost = true; session.watchers.clear(); release(); } };
  };
  return state;
}
const closingRow = (start, end) => ({ kind: 'closing', period: { start, end } });

(async () => {
  // 1. Period naming from the plan alone (no provider).
  const plan = invented('2030-02-15').data;
  eq(Auto.closedPeriod(plan, '2030-02-15'), { start: START, end: END }, 'first day of a period names the one that just ended');
  eq(Auto.closedPeriod(plan, '2030-02-28'), { start: START, end: END }, 'last day of the next period still names it');
  eq(Auto.closedPeriod(plan, '2030-03-01'), { start: '2030-02-15', end: '2030-02-28' }, 'after the next rollover only the newer period is named');
  eq(Auto.closedPeriod({}, '2030-02-15'), null, 'no plan, no period');
  eq(Auto.closedPeriod(plan, 'not-a-day'), null, 'no household date, no period');

  // 2. Switches: both must be exactly 'on'.
  for (const env of [{}, { [Auto.FLAG]: 'on' }, { [Capture.FLAG]: 'on' }, { ...ON, [Auto.FLAG]: 'true' }]) {
    let runs = 0;
    const owner = Auto.create({ env, loadCanonical: () => plan, clock: () => at('2030-02-15T12:00:00Z'),
      run: async () => { runs++; return { closing: 'appended', provider: true }; }, gate: SessionGate.create(), log: () => {} });
    eq(await owner.tick(), 'disabled', 'switched off: ' + JSON.stringify(env));
    eq(runs, 0, 'switched off makes no attempt');
    eq(Auto.start({ env, loadCanonical: () => plan }), null, 'switched off starts no timer');
  }

  eq([...Auto.SLOT_HOURS], [0, 4, 8, 12, 16, 20], 'the six attempt windows are pinned independently of the implementation constant');
  eq(Auto.MAX_PROVIDER_ATTEMPTS_PER_DAY, 6, 'at most six per household day');
  // Window openings are found through the module's own household clock.
  const opening = fromMs => { for (let t = Math.ceil(fromMs / MIN) * MIN; ; t += MIN) { const w = Auto.slotAt(t); if (w && w.opened === t) return t; } };
  const dayOf = ms => require('../public/forecast').financialDate(new Date(ms).toISOString());
  eq(Auto.slotAt(opening(at('2030-02-15T12:00:00Z')) + 14 * MIN) !== null, true, 'inside a window');
  eq(Auto.slotAt(opening(at('2030-02-15T12:00:00Z')) + 15 * MIN), null, 'a window lasts one tick interval');
  {
    const W = opening(at('2030-02-15T12:00:00Z')); const perDay = {};
    for (let t = W - 48 * 60 * MIN; t < W + 48 * 60 * MIN; t += MIN) if (Auto.slotAt(t) && Auto.slotAt(t).opened === t) perDay[dayOf(t)] = (perDay[dayOf(t)] || 0) + 1;
    eq(Object.values(perDay).filter(n => n !== Auto.MAX_PROVIDER_ATTEMPTS_PER_DAY).length <= 2, true, 'six windows per full household day: ' + JSON.stringify(perDay));
  }

  // 3. Once saved, no further attempt for that period (no archive, no provider).
  {
    const W = opening(at('2030-02-15T12:00:00Z'));
    let now = W - 30 * MIN; const calls = []; const logs = [];
    const owner = Auto.create({ env: ON, loadCanonical: () => plan, clock: () => now, gate: SessionGate.create(), log: l => logs.push(l),
      run: async data => { calls.push(data.period); return { closing: 'appended', provider: true }; } });
    eq(await owner.tick(), 'outside-window', 'no attempt outside a window');
    now = W + MIN;
    eq(await owner.tick(), 'appended', 'due tick in a window saves the closing');
    eq(calls, [{ start: START, end: END }], 'one attempt, naming the latest closed period');
    for (let i = 1; i <= 40; i++) { now += 15 * MIN; eq(await owner.tick(), 'saved', 'tick ' + i + ' after saving'); }
    eq(calls.length, 1, 'no attempt on any tick after the closing exists');
    now = opening(at('2030-03-01T12:00:00Z')) + MIN;
    eq(await owner.tick(), 'appended', 'the next rollover names the next period');
    eq(calls[1], { start: '2030-02-15', end: '2030-02-28' }, 'only the newer period, never a catch-up');
    eq(logs.every(l => /^\{"type":"period-history-auto-capture","closing":"[a-z-]+","provider":(true|false)\}$/.test(l)), true, 'logs are fixed codes only');
  }

  // 4. Retry bound from the clock: failing provider attempts, with and
  // without restarts, never exceed one per window and six per household day.
  const failing = perDay => async function () { const d = dayOf(this.now()); perDay[d] = (perDay[d] || 0) + 1;
    return { closing: 'history-observation-unavailable', provider: true }; };
  for (const restartEveryMin of [0, 20, 7, 61]) {
    const perDay = {}; const start = opening(at('2030-02-15T12:00:00Z')) - 30 * MIN; let now = start;
    const ctx = { now: () => now }; const run = failing(perDay).bind(ctx);
    const boot = () => Auto.create({ env: ON, loadCanonical: () => plan, clock: () => now, gate: SessionGate.create(), log: () => {}, run });
    let owner = boot(), lastBoot = now;
    const ticks = [];
    for (; now < start + 3 * 24 * 60 * MIN; now += MIN) {
      if (restartEveryMin && now - lastBoot >= restartEveryMin * MIN) { owner = boot(); lastBoot = now; }
      // Ticks: 60 s after boot, then every 15 minutes.
      const age = now - lastBoot;
      if (age === MIN || (age > MIN && (age - MIN) % (15 * MIN) === 0)) ticks.push(await owner.tick());
    }
    const counts = Object.values(perDay);
    eq(counts.every(n => n <= Auto.MAX_PROVIDER_ATTEMPTS_PER_DAY), true, 'restart every ' + restartEveryMin + ' min: at most six per day ' + JSON.stringify(perDay));
    if (!restartEveryMin) eq(counts.filter(n => n === Auto.MAX_PROVIDER_ATTEMPTS_PER_DAY).length >= 2, true, 'a failing provider is retried in every window');
    if (restartEveryMin === 7) eq(ticks.includes('started-mid-window'), true, 'a process started mid-window waits for the next window');
  }
  {
    // Restart right after a failed attempt: the new process waits for the next window.
    const W = opening(at('2030-02-15T12:00:00Z')); let now = W - 10 * MIN; let n = 0;
    const run = async () => { n++; return { closing: 'history-observation-unavailable', provider: true }; };
    const first = Auto.create({ env: ON, loadCanonical: () => plan, clock: () => now, gate: SessionGate.create(), log: () => {}, run });
    now = W + MIN; await first.tick();
    eq(await first.tick(), 'window-used', 'one attempt per window per process');
    now = W + 2 * MIN;
    const second = Auto.create({ env: ON, loadCanonical: () => plan, clock: () => now, gate: SessionGate.create(), log: () => {}, run });
    now = W + 3 * MIN; eq(await second.tick(), 'started-mid-window', 'restart after a failure: no attempt in the same window');
    now = W + 10 * MIN; await second.tick();
    eq(n, 1, 'still one attempt in that window');
    now = opening(W + MIN) + MIN; await second.tick();
    eq(n, 2, 'the next window retries');
  }
  {
    // Any attempt spends its window, including a refused archive connection,
    // so an instance refused by another instance's session cannot retry in it.
    const W = opening(at('2030-02-15T12:00:00Z')); let now = W - MIN; let n = 0;
    const owner = Auto.create({ env: ON, loadCanonical: () => plan, clock: () => now, gate: SessionGate.create(), log: () => {},
      run: async () => { n++; return { closing: 'history-store-unavailable', provider: false }; } });
    now = W + MIN; await owner.tick(); now = W + 5 * MIN;
    eq(await owner.tick(), 'window-used', 'a refused archive connection spends the window');
    eq(n, 1, 'one attempt per window, whatever its outcome');
  }
  {
    // The session gate is shared: when held, the tick skips.
    const W = opening(at('2030-02-15T12:00:00Z')); let now = W - MIN;
    const gate = SessionGate.create(); const hold = gate.tryAcquire(); let n = 0;
    const owner = Auto.create({ env: ON, loadCanonical: () => plan, clock: () => now, gate, log: () => {},
      run: async () => { n++; return { closing: 'appended', provider: true }; } });
    now = W + MIN;
    eq(await owner.tick(), 'busy', 'held session gate: skip'); eq(n, 0, 'no attempt while the gate is held');
    hold(); eq(await owner.tick(), 'appended', 'gate released: attempt');
  }
  {
    // Default launcher: a hung worker is terminated and waited for, and the
    // session gate stays held until it has exited.
    const { EventEmitter } = require('node:events');
    const W = opening(at('2030-02-15T12:00:00Z')); let now = W - MIN;
    const gate = SessionGate.create(); let terminated = 0, worker;
    const spawn = () => { worker = new EventEmitter(); worker.terminate = async () => { terminated++; await new Promise(r => setTimeout(r, 30)); worker.emit('exit', 1); }; return worker; };
    const owner = Auto.create({ env: ON, loadCanonical: () => plan, clock: () => now, gate, log: () => {}, spawn, workerTimeoutMs: 20 });
    now = W + MIN;
    const pending = owner.tick();
    await new Promise(r => setTimeout(r, 35));
    eq(gate.tryAcquire(), null, 'gate still held while the timed-out worker is being stopped');
    eq(await pending, 'history-capture-timeout', 'timeout reported');
    eq(terminated, 1, 'the hung worker is terminated');
    const free = gate.tryAcquire(); eq(typeof free, 'function', 'gate released only after the worker exited'); free();
    // A worker that answers and exits normally is not terminated.
    const spawnOk = () => { const w = new EventEmitter(); w.terminate = async () => { terminated++; };
      setTimeout(() => { w.emit('message', { closing: 'appended', provider: true }); w.emit('exit', 0); }, 5); return w; };
    now = opening(W + MIN) - MIN;
    const ok = Auto.create({ env: ON, loadCanonical: () => plan, clock: () => now, gate, log: () => {}, spawn: spawnOk, workerTimeoutMs: 1000 });
    now += 2 * MIN;
    eq(await ok.tick(), 'appended', 'normal worker result');
    eq(terminated, 1, 'a normal worker is never terminated');
  }

  // 5. runOnce against a fake archive and a counting fake observation.
  const day = '2030-02-15';
  const fixture = invented(day);
  const buildInput = () => { const v = JSON.parse(JSON.stringify(fixture)); return v; };
  const nowFn = () => new Date(day + 'T18:01:00Z');
  const counting = (check) => { const o = async () => { o.calls++; return check; }; o.calls = 0; return o; };
  const qualified = { qualified: true, evidence: { payload: fixture.payload } };
  {
    const store = archive([closingRow(START, END)]); const observe = counting(qualified);
    const r = await Auto.runOnce({ canonical: fixture.data, env: ON, period: { start: START, end: END }, windowStart: WS, openStore: store.open, observe, buildInput, now: nowFn });
    eq(r, { closing: 'already-captured', provider: false }, 'existing closing: no provider read');
    eq(observe.calls, 0, 'zero provider reads when the closing exists'); eq(store.appends.length, 0, 'nothing appended');
    eq(store.opened, store.retired, 'every archive session retired');
  }
  {
    const store = archive([]); const observe = counting(qualified);
    const r = await Auto.runOnce({ canonical: fixture.data, env: ON, period: { start: START, end: END }, windowStart: WS, openStore: store.open, observe, buildInput, now: nowFn });
    eq(r, { closing: 'appended', provider: true }, 'due: one read, one closing');
    eq(observe.calls, 1, 'exactly one provider read');
    eq(store.appends.map(c => [c.content.kind, c.content.period.start, c.content.period.end]), [['closing', START, END]], 'only the closing is written, never an opening baseline');
    eq(store.opened, store.retired, 'every archive session retired');
    const again = await Auto.runOnce({ canonical: fixture.data, env: ON, period: { start: START, end: END }, windowStart: WS, openStore: store.open, observe, buildInput, now: nowFn });
    eq([again.closing, observe.calls, store.appends.length], ['already-captured', 1, 1], 'a second run (restart) reads nothing and writes nothing');
  }
  for (const [name, check] of [['unqualified', { qualified: false, evidence: null }], ['no evidence', { qualified: true }], ['none', null]]) {
    const store = archive([]);
    const r = await Auto.runOnce({ canonical: fixture.data, env: ON, period: { start: START, end: END }, windowStart: WS, openStore: store.open,
      observe: counting(check), buildInput, now: nowFn });
    eq([r.closing, r.provider, store.appends.length], ['history-observation-unavailable', true, 0], name + ' observation writes nothing');
  }
  {
    const store = archive([]);
    const r = await Auto.runOnce({ canonical: fixture.data, env: ON, period: { start: START, end: END }, windowStart: WS, openStore: store.open,
      observe: async () => { throw new Error('PRIVATE-PROVIDER-TEXT'); }, buildInput, now: nowFn });
    eq(r, { closing: 'history-observation-unavailable', provider: true }, 'a thrown provider read maps to a fixed code');
  }
  {
    const store = archive([]);
    const r = await Auto.runOnce({ canonical: fixture.data, env: ON, period: { start: '2030-01-18', end: '2030-01-31' }, windowStart: WS, openStore: store.open,
      observe: counting(qualified), buildInput, now: nowFn });
    eq([r.closing, store.appends.length], ['not-due', 0], 'an observation naming another period writes nothing');
  }
  {
    const store = archive([]); store.conflict = true;
    const r = await Auto.runOnce({ canonical: fixture.data, env: ON, period: { start: START, end: END }, windowStart: WS, openStore: store.open,
      observe: counting(qualified), buildInput, now: nowFn });
    eq(r.closing, 'already-captured', 'a concurrent writer that won is the same no-op');
  }
  {
    const r = await Auto.runOnce({ canonical: fixture.data, env: ON, period: { start: START, end: END }, windowStart: WS,
      openStore: async () => { throw new Error('PRIVATE-DRIVER-TEXT'); }, observe: counting(qualified), buildInput, now: nowFn });
    eq(r, { closing: 'history-store-unavailable', provider: false }, 'archive unreachable: no provider read');
  }

  // 5b. Two server instances alive at the same window opening (deploy
  // overlap) share one archive whose writer role allows one connection: the
  // session held across check, observation and append makes exactly one
  // provider observation fleet-wide.
  {
    const W = opening(at('2030-02-15T12:00:00Z')); let now = W - 10 * MIN;
    const store = archive([], { limitOne: true });
    let observations = 0, release;
    const barrier = new Promise(r => { release = r; });
    const observe = async () => { observations++; await barrier; return qualified; };
    const instance = () => Auto.create({ env: ON, loadCanonical: () => fixture.data, clock: () => now, gate: SessionGate.create(), log: () => {},
      run: data => Auto.runOnce({ ...data, env: ON, openStore: store.open, observe, buildInput, now: nowFn }) });
    const a = instance(), b = instance();
    now = W + MIN;
    const first = a.tick();
    await new Promise(r => setImmediate(r));
    const bounded = promise => Promise.race([promise, new Promise(r => setTimeout(() => r('still-running'), 1000))]);
    eq(await bounded(b.tick()), 'history-store-unavailable', 'second instance is refused while the first holds the session');
    eq(observations, 1, 'the refused instance made no provider request');
    release();
    eq(await first, 'appended', 'first instance saves the closing');
    now = W + 5 * MIN;
    eq(await b.tick(), 'window-used', 'the refused instance does not retry in the same window');
    now = opening(W + MIN) + MIN;
    eq(await b.tick(), 'already-captured', 'next window: the closing is found in the archive');
    eq([observations, store.appends.length, store.active], [1, 1, 0], 'one observation, one closing, no session left open');
  }
  {
    // Same overlap with a failing provider: still one observation per window.
    const W = opening(at('2030-02-15T12:00:00Z')); let now = W - 10 * MIN;
    const store = archive([], { limitOne: true }); let observations = 0;
    const observe = async () => { observations++; await new Promise(r => setTimeout(r, 5)); return null; };
    const instance = () => Auto.create({ env: ON, loadCanonical: () => fixture.data, clock: () => now, gate: SessionGate.create(), log: () => {},
      run: data => Auto.runOnce({ ...data, env: ON, openStore: store.open, observe, buildInput, now: nowFn }) });
    const a = instance(), b = instance();
    now = W + MIN;
    const pa = a.tick(); await new Promise(r => setImmediate(r)); const pb = b.tick();
    await Promise.all([pa, pb]);
    now = W + 7 * MIN; await a.tick(); await b.tick();
    eq(observations, 1, 'failing provider, two truly concurrent instances: one observation at a time, the refused one spends its window');
  }
  for (const [name, check, expected] of [['after a failure', null, 1], ['after a success', qualified, 1]]) {
    // Two instances both alive at the window opening, ticking eight minutes
    // apart (not concurrent): after a failure the second finds the window
    // already claimed; after a success it finds the saved closing.
    const W = opening(at('2030-02-15T12:00:00Z')); let now = W - 10 * MIN;
    const store = archive([], { limitOne: true }); let observations = 0;
    const observe = async () => { observations++; return check; };
    const instance = () => Auto.create({ env: ON, loadCanonical: () => fixture.data, clock: () => now, gate: SessionGate.create(), log: () => {},
      run: data => Auto.runOnce({ ...data, env: ON, openStore: store.open, observe, buildInput, now: nowFn }) });
    const a = instance(), b = instance();
    now = W + MIN; await a.tick();
    now = W + 9 * MIN; await b.tick();
    eq(observations, expected, 'sequential instances ' + name + ': ' + expected + ' observation(s) in the window');
    eq(store.appends.length, check ? 1 : 0, 'sequential instances ' + name + ': closings written');
  }

  // 5c. Archive ownership lost around the observation (Atlas 6814974446).
  {
    // A pending, A's session lost, B starts: A's read is aborted before B's begins.
    const store = archive([], { limitOne: true }); const events = [];
    let releaseB;
    const observeA = (canonical, env, signal) => new Promise(resolve => {
      events.push('A-start');
      signal.addEventListener('abort', () => { events.push('A-aborted'); resolve(qualified); }, { once: true });
    });
    const observeB = async () => { events.push('B-start'); return qualified; };
    const pendingA = Auto.runOnce({ canonical: fixture.data, env: ON, period: { start: START, end: END }, windowStart: WS, openStore: store.open, observe: observeA, buildInput, now: nowFn });
    await new Promise(r => setTimeout(r, 10));
    eq(events, ['A-start'], 'A observing while it holds the session');
    const refused = await Auto.runOnce({ canonical: fixture.data, env: ON, period: { start: START, end: END }, windowStart: WS, openStore: store.open, observe: observeB, buildInput, now: nowFn });
    eq(refused, { closing: 'history-store-unavailable', provider: false }, 'B refused while A holds the session');
    store.sessions[0].lose(); // the connection owner loses A's session
    const same = await Auto.runOnce({ canonical: fixture.data, env: ON, period: { start: START, end: END }, windowStart: WS, openStore: store.open, observe: observeB, buildInput, now: nowFn });
    eq(same, { closing: 'history-window-claimed', provider: false }, 'B in the same window finds it claimed and reads nothing');
    const b = await Auto.runOnce({ canonical: fixture.data, env: ON, period: { start: START, end: END }, windowStart: WS2, openStore: store.open, observe: observeB, buildInput, now: nowFn });
    const a = await Promise.race([pendingA, new Promise(r => setTimeout(() => r('still-observing'), 1000))]);
    eq(events, ['A-start', 'A-aborted', 'B-start'], 'A is aborted before B (next window) starts its read');
    eq(a, { closing: 'history-session-lost', provider: true }, 'A reports the lost session');
    eq(b.closing, 'appended', 'B saves the closing in the next window');
    eq(store.appends.length, 1, 'A appends nothing');
  }
  {
    // Loss before the observation starts: no provider request at all.
    const store = archive([], { limitOne: true }); let observed = 0;
    const open = async () => { const s = await store.open(); const sess = store.sessions.at(-1); const read = s.read;
      return { ...s, read: async () => { const rows = await read(); sess.lose(); return rows; } }; };
    const r = await Auto.runOnce({ canonical: fixture.data, env: ON, period: { start: START, end: END }, windowStart: WS, openStore: open,
      observe: async () => { observed++; return qualified; }, buildInput, now: nowFn });
    eq([r.provider, observed, store.appends.length], [false, 0, 0], 'loss before the read (' + r.closing + '): no provider request, nothing written');
  }
  {
    // Loss after the observation finishes, before the append: nothing written.
    const store = archive([], { limitOne: true });
    const r = await Auto.runOnce({ canonical: fixture.data, env: ON, period: { start: START, end: END }, windowStart: WS, openStore: store.open,
      observe: async () => qualified, buildInput: (...args) => { store.sessions.at(-1).lose(); return buildInput(...args); }, now: nowFn });
    eq([r.closing, r.provider, store.appends.length], ['history-store-unavailable', true, 0], 'loss after the read: the append is refused, nothing written');
  }
  {
    // A store that cannot report loss is never used for an observation.
    let observed = 0;
    const r = await Auto.runOnce({ canonical: fixture.data, env: ON, period: { start: START, end: END }, windowStart: WS,
      openStore: async () => ({ read: async () => [], append: async () => assert.fail('no append'), retire: async () => {} }),
      observe: async () => { observed++; return qualified; }, buildInput, now: nowFn });
    eq([r, observed], [{ closing: 'history-session-unguarded', provider: false }, 0], 'no loss signal: no observation');
  }

  // 5d. Fleet-wide cap from the window claims (#821 6822615033): any number of
  // instances, staggered ticks and random restarts, failing provider, shared
  // archive WITHOUT the one-connection limit (so only the claims bound it).
  {
    let seed = 7; const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (const count of [1, 2, 3, 5, 10]) {
      const store = archive([]); const perDay = {};
      let start = opening(at('2030-02-15T12:00:00Z'));
      while (!Auto.slotAt(start).key.endsWith('T00')) start = opening(start + MIN);
      let now = start - 90 * MIN;
      const observe = async () => { const d = dayOf(now); perDay[d] = (perDay[d] || 0) + 1; return null; };
      const instances = Array.from({ length: count }, (_, i) => ({ boot: now + Math.floor(rand() * 30) * MIN + i * MIN, owner: null }));
      const make = o => { o.owner = Auto.create({ env: ON, loadCanonical: () => fixture.data, clock: () => now, gate: SessionGate.create(), log: () => {},
        run: data => Auto.runOnce({ ...data, env: ON, openStore: store.open, observe, buildInput, now: nowFn }) }); };
      for (; now < start + 3 * 24 * 60 * MIN; now += MIN) {
        for (const o of instances) {
          if (o.owner && rand() < 0.002) { o.owner = null; o.boot = now + MIN; } // restart
          if (!o.owner && now >= o.boot) make(o);
          if (!o.owner) continue;
          const age = now - o.boot;
          if (age === MIN || (age > MIN && (age - MIN) % (15 * MIN) === 0)) await o.owner.tick();
        }
      }
      const counts = Object.values(perDay);
      eq(counts.every(n => n <= 6), true, count + ' instance(s), restarts, failing provider: never more than six observations per household day ' + JSON.stringify(perDay));
      if (count === 10) eq(counts.some(n => n === 6), true, 'a failing day uses all six windows fleet-wide');
    }
  }
  {
    // Atlas 6826824423: two instances whose plans name different closed periods
    // (different payroll anchors, e.g. during a plan-changing deploy) still
    // share one claim per window, so the fleet stays at six a household day.
    const otherPlan = JSON.parse(JSON.stringify(fixture.data)); otherPlan.plan.income[0].anchor = '2030-02-02';
    const store = archive([]); const perDay = {};
    let start = opening(at('2030-02-15T12:00:00Z'));
    while (!Auto.slotAt(start).key.endsWith('T00')) start = opening(start + MIN);
    let now = start - 30 * MIN; const named = new Set();
    const make = canonical => Auto.create({ env: ON, loadCanonical: () => canonical, clock: () => now, gate: SessionGate.create(), log: () => {},
      run: data => { named.add(data.period.start + '..' + data.period.end);
        return Auto.runOnce({ ...data, env: ON, openStore: store.open, observe: async () => { const d = dayOf(now); perDay[d] = (perDay[d] || 0) + 1; return null; }, buildInput, now: nowFn }); } });
    const a = make(fixture.data), b = make(otherPlan);
    for (; now < start + 24 * 60 * MIN; now += MIN) {
      const age = now - (start - 30 * MIN);
      if (age === MIN || (age > MIN && (age - MIN) % (15 * MIN) === 0)) { await a.tick(); }
      if (age === 2 * MIN || (age > 2 * MIN && (age - 2 * MIN) % (15 * MIN) === 0)) { await b.tick(); }
    }
    eq(named.size, 2, 'the two plans name different closed periods ' + JSON.stringify([...named]));
    eq(Object.values(perDay).every(n => n <= 6), true, 'mixed plans: never more than six observations per household day ' + JSON.stringify(perDay));
  }
  {
    // No claims capability, or a failing claim: no provider request.
    for (const [name, extra, expected] of [
      ['no claims table', { claimWindow: undefined }, 'history-claims-unavailable'],
      ['claim refused', { claimWindow: async () => { const e = new Error('history-store-unavailable'); e.code = e.message; throw e; } }, 'history-store-unavailable'],
    ]) {
      const store = archive([]); let observed = 0;
      const open = async () => { const s0 = await store.open(); const s1 = { ...s0, ...extra }; if (!s1.claimWindow) delete s1.claimWindow; return s1; };
      const r = await Auto.runOnce({ canonical: fixture.data, env: ON, period: { start: START, end: END }, windowStart: WS, openStore: open,
        observe: async () => { observed++; return qualified; }, buildInput, now: nowFn });
      eq([r, observed], [{ closing: expected, provider: false }, 0], name + ': no provider request');
    }
  }

  // 6. Real observation path against a loopback provider: count requests and
  // methods across ticks and simulated restarts. The served refresh module
  // (and its observation memory) is never loaded.
  {
    const payload = Fixture.payload(), canonical = Fixture.canonical();
    const calls = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      calls.push(req.method + ' ' + url.pathname);
      const send = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (url.pathname === '/v2/me') return send({ user_id: 1 });
      if (url.pathname === '/v2/plaid_accounts') return send({ plaid_accounts: payload.accounts });
      if (url.pathname === '/v2/manual_accounts') return send({ manual_accounts: [] });
      if (url.pathname === '/v2/categories') return send({ categories: payload.categories });
      if (url.pathname === '/v2/tags') return send({ tags: [] });
      if (url.pathname === '/v2/transactions') {
        const pending = url.searchParams.get('is_pending') === 'true';
        return send({ has_more: false, transactions: payload.transactions.filter(tx => !pending || tx.is_pending) });
      }
      res.writeHead(404); res.end('{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const env = { ...ON, ATLAS_LIVE_OVERLAY: 'live', LUNCHMONEY_ACCESS_TOKEN: 'SYNTHETIC-TOKEN',
      ATLAS_LUNCHMONEY_API_BASE: 'http://127.0.0.1:' + server.address().port + '/v2',
      ATLAS_LIVE_OVERLAY_NOW: payload.fetchedAt, ATLAS_PROVIDER_ACCOUNT_MAP_JSON: JSON.stringify({ ...Fixture.map, scope: 'live' }) };
    const meCalls = () => calls.filter(c => c.endsWith('/v2/me')).length;
    const store = archive([]);
    let now = opening(at('2026-08-20T19:00:00Z')) - 5 * MIN;
    const boot = () => Auto.create({ env, loadCanonical: () => canonical, clock: () => now, gate: SessionGate.create(), log: () => {},
      run: data => Auto.runOnce({ ...data, env, openStore: store.open }) });
    let owner = boot(); now += 6 * MIN;
    const first = await owner.tick();
    eq(meCalls(), 1, 'a due tick makes one provider read set (' + first + ')');
    const saved = store.rows.some(r => r.kind === 'closing');
    if (process.env.AUTO_CAPTURE_TEST_VERBOSE) console.log('loopback first tick:', first, 'saved:', saved);
    // Ticks across windows, then a restart, then more ticks.
    for (let i = 0; i < 40; i++) { now += 15 * MIN; await owner.tick(); }
    owner = boot();
    for (let i = 0; i < 40; i++) { now += 15 * MIN; await owner.tick(); }
    eq([first, saved], ['appended', true], 'the real observation path saves the invented closing');
    eq(meCalls(), 1, 'once the closing exists, no later tick or restart reads the provider');
    eq(calls.every(c => c.startsWith('GET ')), true, 'every provider request is a GET');
    eq(store.appends.every(c => c.content.kind === 'closing'), true, 'only closing records are written');
    eq(Object.keys(require.cache).some(f => /server-live-refresh\.js$/.test(f)), false, 'the served refresh and its observation memory are never loaded');
    // With the closing already in the archive, a fresh process reads nothing.
    const before = meCalls(); const full = archive([closingRow('2026-07-31', '2026-08-13')]);
    const fresh = Auto.create({ env, loadCanonical: () => canonical, clock: () => now, gate: SessionGate.create(), log: () => {},
      run: data => Auto.runOnce({ ...data, env, openStore: full.open }) });
    for (let i = 0; i < 40; i++) { now += 15 * MIN; await fresh.tick(); }
    eq(full.reads > 0, true, 'the fresh process checked the archive');
    eq(meCalls(), before, 'restart with the closing saved: zero provider requests');
    server.close();
  }
  console.log('PASS period-history auto-capture (' + checks + ' checks)');
})().catch(error => { console.error(error); process.exit(1); });
