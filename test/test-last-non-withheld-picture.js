'use strict';
// Dale, 2026-11-18: "If we have a failure where the whole page goes down we
// should just keep it at the last full picture." A whole-plan hold can also be
// raised on a COMPLETE refresh (for example an early deposit to confirm makes
// income reconciliation unavailable). That refresh is the newest retained
// cohort, so before this change the page showed the hold (the Unknown shell),
// not the last full picture. The process-local observation slot now keeps the
// last NON-WITHHELD complete publication as well, and the server serves it,
// as the retained picture, when the newest is withheld. Since OD-025 (Dale,
// 2026-11-19) the page shows it with no banner and no reason line. Invented data only; no
// provider write, credential or household file.
//
// The withheld refresh is simulated by a worker-only preload that sets
// liveOverlay.operatingPlan 'unavailable' on an otherwise complete result
// while a flag file exists: the one field the server reads to decide it,
// exactly as the observer's income reconciliation sets it.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const threads = require('node:worker_threads');

const WITHHELD_NOTE = 'Early deposit to confirm (invented): future cash and spending stay unavailable.';
if (!threads.isMainThread && process.env.ATLAS_SYNTHETIC_WITHHOLD_FLAG) {
  const Live = require('../scripts/live-plan'), apply = Live.applyForServer;
  Live.applyForServer = async (...args) => {
    const data = await apply(...args);
    if (data && data.liveOverlay && fs.existsSync(process.env.ATLAS_SYNTHETIC_WITHHOLD_FLAG)) {
      data.liveOverlay.operatingPlan = 'unavailable';
      data.liveOverlay.operatingPlanNote = WITHHELD_NOTE;
    }
    return data;
  };
}

if (threads.isMainThread && require.main === module) (async () => {
  let checks = 0;
  const check = (cond, msg) => { assert.ok(cond, msg); checks++; };
  const Memory = require('../scripts/server-observation-memory');
  const Live = require('../scripts/live-plan');

  console.log('1. The memory slot keeps the last non-withheld complete publication');
  {
    const complete = { liveOverlay: { applied: true, operatingPlan: 'live', currentPeriodActuals: { transactionCoverage: 'complete' } } };
    const withheld = { liveOverlay: { ...complete.liveOverlay, operatingPlan: 'unavailable' } };
    const FixturePayload = require('./fixtures/budget-surface-data').payload;
    const evidence = at => ({ schema: Memory.SCHEMA, payload: { ...FixturePayload(), tags: [], fetchedAt: at } });
    const display = (at, data, extra = {}) => ({ context: { k: 'ctx' }, householdAccountId: 1, lastBudgetAccountId: 1,
      credentialSource: 'env', checkedAt: at, data: { ...structuredClone(data), at }, ...extra });
    const m = Memory.create(), ctx = { k: 'ctx' };
    check(Memory.planWithheld(withheld) && !Memory.planWithheld(complete), 'planWithheld reads the whole-plan hold');
    m.publish('c', evidence('2026-01-01T10:00:00Z'), display('2026-01-01T10:00:00Z', complete));
    check(m.readClearDisplay(ctx).data.at === '2026-01-01T10:00:00Z', 'a clear publication is the clear picture');
    m.publish('c', evidence('2026-01-01T11:00:00Z'), display('2026-01-01T11:00:00Z', withheld));
    check(m.readDisplay(ctx).data.at === '2026-01-01T11:00:00Z', 'the withheld publication is still the newest display');
    check(m.readClearDisplay(ctx).data.at === '2026-01-01T10:00:00Z', 'but never replaces the clear picture');
    m.observeBudget(2); m.noteAttempt(ctx, { reason: 'provider-unavailable' });
    const clear = m.readClearDisplay(ctx);
    check(clear.lastBudgetAccountId === 2 && clear.attempt.reason === 'provider-unavailable',
      'the clear picture reads the current household check and attempt');
    clear.data.at = 'mutated';
    check(m.readClearDisplay(ctx).data.at === '2026-01-01T10:00:00Z', 'reads are copies');
    check(m.readClearDisplay({ k: 'other' }) === null, 'an incompatible context cannot read it');
    m.publish('c', evidence('2026-01-01T12:00:00Z'), display('2026-01-01T12:00:00Z', complete));
    check(m.readClearDisplay(ctx).data.at === '2026-01-01T12:00:00Z', 'a later clear publication replaces it');
    m.publish('c', evidence('2026-01-01T13:00:00Z'), null);
    check(m.readDisplay(ctx) === null && m.readClearDisplay(ctx) === null,
      'when the display slot empties, the clear one empties too (nothing older than a superseding picture)');
    m.publish('c', evidence('2026-01-01T14:00:00Z'), display('2026-01-01T14:00:00Z', complete));
    m.clear();
    check(m.readClearDisplay(ctx) === null, 'clear() (an OD-2 supersession) empties it');
    m.publish('c', evidence('2026-01-01T15:00:00Z'), display('2026-01-01T15:00:00Z', withheld));
    check(m.readClearDisplay(ctx) === null, 'a withheld first publication leaves no clear picture');
    check(Memory.create().readClearDisplay(ctx) === null, 'a new process holds no clear picture (no persistence)');
    // A withheld publication under a different display context (the account
    // map or category mapping changed) supersedes the clear picture: it is
    // dropped, so a later return to the old context cannot revive it.
    {
      const c = Memory.create(), other = { k: 'other' };
      c.publish('c', evidence('2026-01-02T10:00:00Z'), display('2026-01-02T10:00:00Z', complete));
      c.publish('c', evidence('2026-01-02T11:00:00Z'), { ...display('2026-01-02T11:00:00Z', withheld), context: other });
      check(c.readClearDisplay(other) === null, 'a withheld publication under a new context has no clear picture of its own');
      c.publish('c', evidence('2026-01-02T12:00:00Z'), display('2026-01-02T12:00:00Z', withheld));
      check(c.readClearDisplay(ctx) === null,
        'returning to the old context does not revive the clear picture a newer context superseded');
    }
  }

  console.log('2. The page prints no banner and no reason line for a retained picture (OD-025)');
  {
    const plan = fs.readFileSync(path.join(__dirname, '..', 'public', 'plan.js'), 'utf8');
    check(!/RETAINED_PICTURE_REASONS|retainedPictureBannerHtml|budget-retained-banner/.test(plan),
      'public/plan.js holds no banner and no per-reason lines');
    const serverCodes = [...Live.RETAINED_ATTEMPT_REASONS].sort();
    check(serverCodes.includes('current-plan-withheld'), 'the withheld reason is still in the server\'s closed attempt set');
  }

  console.log('3. The real server serves the last full picture when the newest refresh is withheld');
  {
    const Helpers = require('./test-server-observation-memory');
    const Fixture = require('./fixtures/budget-surface-data');
    const flag = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-withhold-')), 'withhold');
    const workerExits = [], RealWorker = threads.Worker;
    threads.Worker = class extends RealWorker {
      constructor(...args) { super(...args); workerExits.push(new Promise(resolve => this.once('exit', resolve))); }
    };
    const drain = () => Promise.all(workerExits);
    const originalNow = Date.now;
    Date.now = () => Date.parse(Helpers.CLOCK);
    const mock = await Helpers.provider({ accountId: 424242 });
    const env = { ...Helpers.environment(mock.base), ATLAS_SYNTHETIC_WITHHOLD_FLAG: flag,
      NODE_OPTIONS: '--require "' + __filename.replace(/\\/g, '/') + '"' };
    const canonical = Fixture.canonical();
    delete require.cache[require.resolve('../scripts/server-live-refresh')];
    const Refresh = require('../scripts/server-live-refresh');
    try {
      let firstCheck = null;
      const first = await Refresh.serve(canonical, env, { forceRefresh: true, onCheck(value) { firstCheck = value; } }); await drain();
      check(first.liveOverlay.operatingPlan !== 'unavailable' && !first.liveOverlay.retainedRefresh,
        'a clean complete refresh is current: no hold, no retained picture');
      check(first.liveOverlay.currentPeriodActuals?.transactionCoverage === 'complete', 'the invented refresh is a complete cohort');

      fs.writeFileSync(flag, '1');
      const held = await Refresh.serve(canonical, env, { forceRefresh: true }); await drain();
      check(held.liveOverlay.operatingPlan !== 'unavailable', 'a withheld complete refresh serves the last full picture, not the hold');
      check(held.liveOverlay.retainedRefresh?.attempt?.reason === 'current-plan-withheld',
        'as the retained picture, with the withheld reason (' + held.liveOverlay.retainedRefresh?.attempt?.reason + ')');
      check(typeof firstCheck?.checkedAt === 'string' && held.liveOverlay.retainedRefresh.observedAt === firstCheck.checkedAt,
        'dated as the full picture: the first publication\'s own check time');
      check(JSON.stringify(held.plan) === JSON.stringify(first.plan), 'the picture\'s plan is the full publication, unchanged');


      // An ordinary page load next replays the newest (withheld) observation;
      // it shows the same last full picture, and is not a new provider check.
      const replay = await Refresh.serve(canonical, env, { preferObservation: true }); await drain();
      check(replay.liveOverlay.operatingPlan !== 'unavailable'
        && replay.liveOverlay.retainedRefresh?.attempt?.reason === 'current-plan-withheld',
        'an ordinary load replaying the withheld refresh also shows the last full picture (' + replay.liveOverlay.operatingPlan + ')');
      check(replay.liveOverlay.retainedRefresh.attempt.source === null, 'the replay is not reported as a new provider check');
      check(JSON.stringify(replay.plan) === JSON.stringify(first.plan), 'the replayed picture\'s plan is the full publication, unchanged');

      mock.mode('failure');
      const failed = await Refresh.serve(canonical, env, { forceRefresh: true }).catch(error => ({ error })); await drain();
      check(!failed.error && failed.liveOverlay.operatingPlan !== 'unavailable' && failed.liveOverlay.retainedRefresh,
        'a later failed refresh still shows the last full picture, not the withheld one');

      mock.mode('ok'); fs.unlinkSync(flag);
      const again = await Refresh.serve(canonical, env, { forceRefresh: true }); await drain();
      check(again.liveOverlay.operatingPlan !== 'unavailable' && !again.liveOverlay.retainedRefresh, 'a later clean refresh is current again');
    } finally {
      await drain().catch(() => {});
      await mock.close();
    }

    // A process that has only ever seen the withheld refresh holds no full
    // picture: it serves the withheld page (the Budget shell), as before.
    delete require.cache[require.resolve('../scripts/server-live-refresh')];
    const Cold = require('../scripts/server-live-refresh');
    const coldMock = await Helpers.provider({ accountId: 424242 });
    const coldEnv = { ...Helpers.environment(coldMock.base), ATLAS_SYNTHETIC_WITHHOLD_FLAG: flag,
      NODE_OPTIONS: '--require "' + __filename.replace(/\\/g, '/') + '"' };
    try {
      fs.writeFileSync(flag, '1');
      const cold = await Cold.serve(canonical, coldEnv, { forceRefresh: true }); await drain();
      check(cold.liveOverlay.operatingPlan === 'unavailable' && cold.liveOverlay.operatingPlanNote === WITHHELD_NOTE,
        'with no earlier full picture, the withheld page is served as before');
    } finally {
      await drain().catch(() => {}); await coldMock.close(); fs.rmSync(path.dirname(flag), { recursive: true, force: true });
      threads.Worker = RealWorker; Date.now = originalNow;
    }
  }

  console.log('4. Evidence-day precedence reads the newest held cohort, not the clear picture');
  {
    // A dated evidence-day view newer than the clear picture but older than the
    // withheld cohort never wins, and never drops what is held (lead rulings
    // 6788227366 / 6788734379).
    const Helpers = require('./test-server-observation-memory');
    const Fixture = require('./fixtures/budget-surface-data');
    const flag = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-withhold-')), 'withhold');
    const workerExits = [], RealWorker = threads.Worker;
    threads.Worker = class extends RealWorker {
      constructor(...args) { super(...args); workerExits.push(new Promise(resolve => this.once('exit', resolve))); }
    };
    const drain = () => Promise.all(workerExits);
    const originalNow = Date.now; let now = Helpers.CLOCK;
    Date.now = () => Date.parse(now);
    const synced = at => { const p = { ...Fixture.payload(), tags: [] };
      p.accounts = p.accounts.map(a => ({ ...a, balance_last_update: at, updated_at: at })); return p; };
    const mock = await Helpers.provider({ accountId: 424242 });
    const env = { ...Helpers.environment(mock.base), ATLAS_SYNTHETIC_WITHHOLD_FLAG: flag,
      NODE_OPTIONS: '--require "' + __filename.replace(/\\/g, '/') + '"' };
    const canonical = Fixture.canonical();
    delete require.cache[require.resolve('../scripts/server-live-refresh')];
    delete require.cache[require.resolve('../scripts/server-observation-memory')];
    const Refresh = require('../scripts/server-live-refresh');
    const serve = async (at, payload, options) => { now = at; mock.payload(payload);
      const data = await Refresh.serve(canonical, { ...env, ATLAS_LIVE_OVERLAY_NOW: at }, options).catch(error => ({ error }));
      await drain(); return data; };
    try {
      const clear = await serve('2026-08-18T18:10:00.000Z', synced('2026-08-18T17:55:00.000Z'), { forceRefresh: true });
      check(clear.meta?.asOf === '2026-08-18' && !clear.liveOverlay.retainedRefresh, 'the Aug 18 refresh is the clear picture');
      fs.writeFileSync(flag, '1');
      const held = await serve('2026-08-20T18:00:00.000Z', synced('2026-08-20T17:55:00.000Z'), { forceRefresh: true });
      check(held.meta?.asOf === '2026-08-18' && held.liveOverlay.retainedRefresh?.attempt?.reason === 'current-plan-withheld',
        'the Aug 20 refresh is withheld, so the Aug 18 picture shows as the retained picture');
      fs.unlinkSync(flag);
      // The bank's own last sync is Aug 19: between the two held cohorts.
      const between = await serve('2026-08-20T18:30:00.000Z', synced('2026-08-19T17:55:00.000Z'), { forceRefresh: true });
      check(!between.error && between.meta?.asOf !== '2026-08-19',
        'a view older than the newest held cohort is not served (got ' + (between.meta?.asOf || between.error?.code) + ')');
      check(between.meta?.asOf === '2026-08-18' && !!between.liveOverlay.retainedRefresh, 'the last full picture still shows, as the retained picture');
      mock.mode('failure');
      const later = await serve('2026-08-20T18:40:00.000Z', synced('2026-08-19T17:55:00.000Z'), { forceRefresh: true });
      check(!later.error && later.meta?.asOf === '2026-08-18', 'nothing held was dropped: a later failure still shows the last full picture');
    } finally {
      await drain().catch(() => {}); await mock.close(); fs.rmSync(path.dirname(flag), { recursive: true, force: true });
      threads.Worker = RealWorker; Date.now = originalNow;
    }
  }

  console.log(`\nAll last non-withheld picture checks passed (${checks}).`);
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
