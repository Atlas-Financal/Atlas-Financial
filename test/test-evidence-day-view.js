'use strict';
// OD-2 (#821, owner 2026-11-11): the same provider evidence gives the same
// Budget whatever the request clock or a restart. Invented household only
// (test/fixtures/budget-surface-data.js); the repository's loopback fake
// provider answers GETs only; no data.json, credential or provider write.
//
// Independent proof: the evidence-day view is compared with the incumbent,
// unchanged own-day evaluation of the same evidence (a qualified current
// refresh made on the evidence day itself) and with the incumbent warm
// retained cohort, never with itself. Non-vacuous: valid views are kept and
// invalid answers are still refused in the same run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const threads = require('node:worker_threads');
const Fixture = require('./fixtures/budget-surface-data');
const F = require('../public/forecast');
const helpers = require('./test-server-observation-memory');

const RealWorker = threads.Worker, exits = [];
threads.Worker = class extends RealWorker {
  constructor(...args) { super(...args); exits.push(new Promise(resolve => this.once('exit', resolve))); }
};
// Reuse the existing active Budget VM harness, not a replacement renderer.
const rendererFile = path.join(__dirname, 'test-atlas-077-malformed-amounts.js');
const renderer = new Module(rendererFile, module); renderer.filename = rendererFile;
renderer.paths = Module._nodeModulePaths(__dirname);
renderer._compile(fs.readFileSync(rendererFile, 'utf8').split('const budgetPage = createBudgetPage();')[0]
  + '\nmodule.exports = { createBudgetPage, strip };', rendererFile);

let checks = 0;
const eq = (actual, expected, label) => { assert.deepStrictEqual(actual, expected, label); checks++; };
const quiet = async fn => { const e = console.error, l = console.log; console.error = console.log = () => {};
  try { return await fn(); } finally { console.error = e; console.log = l; } };
const page = renderer.exports.createBudgetPage();
const render = data => quiet(() => renderer.exports.strip(page.render(data)));
const withoutNote = text => text.replace(/Latest complete refresh:[^.]*\.[^.]*\./, '');
const money = (text, label) => (text.match(new RegExp(label + '[^$]{0,24}(\\$[\\d,]+\\.\\d\\d)')) || [])[1] || null;
const figures = text => ({ cashNeeded: money(text, 'Cash needed'),
  householdRemaining: money(text, 'Household spending remaining'), billsDue: money(text, 'Bills & debt payments') });
// The financial basis Forecast reads; request-time provenance is excluded.
const basis = data => {
  const actuals = structuredClone(data.liveOverlay.currentPeriodActuals);
  return { meta: data.meta, plan: data.plan, debts: data.debts, actuals,
    recommend: F.recommend(data.plan, data.meta.asOf, { debts: data.debts, extraFacilities: data.revolvingExtra,
      currentPeriodActuals: data.liveOverlay.currentPeriodActuals, operatingPlan: data.liveOverlay.operatingPlan }) };
};

const DAY = '2026-08-19', NEXT = Fixture.AS_OF; // evidence day, and the fixture's own next day
const BALANCE_AT = DAY + 'T17:55:00.000Z';      // Aug 19, 10:55 a.m. Pacific
const lastSync = mutate => {
  const p = { ...Fixture.payload(), tags: [] };
  p.accounts = p.accounts.map(a => ({ ...a, balance_last_update: BALANCE_AT, updated_at: BALANCE_AT }));
  if (mutate) mutate(p);
  return p;
};

(async () => {
  const mock = await helpers.provider({ accountId: 501 });
  const env = helpers.environment(mock.base), canonical = Fixture.canonical(), realNow = Date.now;
  let now = helpers.CLOCK; Date.now = () => Date.parse(now);
  const fresh = () => { // a new process: no retained cohort and no replay evidence
    for (const key of Object.keys(require.cache)) {
      if (/scripts[\\/](server-live-refresh|server-observation-memory)\.js$/.test(key)) delete require.cache[key];
    }
    return require('../scripts/server-live-refresh');
  };
  const serve = async (Refresh, payload, at, options = {}) => {
    now = at; mock.payload(payload); let check = null; const before = mock.calls.length;
    try {
      const data = await quiet(() => Refresh.serve(canonical, { ...env, ATLAS_LIVE_OVERLAY_NOW: at },
        { ...options, onCheck(value) { check = value; } }));
      await Promise.all(exits);
      return { data, check, calls: mock.calls.length - before };
    } catch (error) { await Promise.all(exits); return { error: error.code || error.message, calls: mock.calls.length - before }; }
  };
  const unavailable = r => !!r.error || r.data.liveOverlay.operatingPlan === 'unavailable';
  try {
    // 1. Reference: the same evidence fetched on its own day, through the unchanged path.
    const warm = fresh();
    const own = await serve(warm, lastSync(), DAY + 'T18:10:00.000Z', { forceRefresh: true });
    eq([own.check.qualified, own.data.meta.asOf, own.data.liveOverlay.applied], [true, DAY, true],
      'own-day evidence is a qualified current Budget (reference)');
    const ownText = await render(own.data), ownFigures = figures(ownText);
    eq(Object.values(ownFigures).every(Boolean), true, 'reference prints its Budget figures');

    // 2. A restart, then the next day before the bank syncs again (audit F1 / S3).
    const cold = await serve(fresh(), lastSync(), NEXT + 'T18:00:00.000Z', { preferObservation: true });
    eq(cold.calls, 7, 'cold process asks the provider');
    eq(cold.check.qualified, false, 'the dated view is never a qualified current check');
    eq(cold.data.meta.asOf, DAY, 'the view is as of the evidence day, never promoted to today');
    eq(cold.data.liveOverlay.retainedRefresh.attempt.reason, 'stale-live-cash-evidence', 'the view keeps the incumbent dated descriptor');
    eq(cold.data.liveOverlay.retainedRefresh.observedAt, BALANCE_AT, 'the view is timed by the balance evidence, not the request');
    eq(cold.data.liveOverlay.currentPeriodActuals.transactionCoverage, 'complete', 'coverage of the dated view is complete');
    eq(basis(cold.data), basis(own.data), 'dated view equals the own-day evaluation of the same evidence');
    const coldText = await render(cold.data);
    eq(/Figures are unavailable/.test(coldText), false, 'a restart no longer blanks valid dated evidence');
    eq(figures(coldText), ownFigures, 'the household sees the own-day figures');
    // No trust tag moves toward certainty: the view keeps the incumbent dated labels.
    eq(cold.data.refreshTrust.displayState, 'attention-needed', 'the dated view never claims current');
    eq(coldText.includes('Balance at this refresh'), true, 'the Budget balance heading stays dated');
    // Hand arithmetic from the invented source inputs, not Forecast self-comparison.
    eq(cold.data.plan.startingCash.breakdown.filter(r => r.id === 'chequing-a' || r.id === 'chequing-b')
      .reduce((sum, r) => sum + r.value, 0), 1215 + 160, 'dated view carries the provider chequing balances');

    // 3. The same evidence in a process that stayed up (incumbent retained cohort, audit S2).
    const warmNext = await serve(warm, lastSync(), NEXT + 'T18:00:00.000Z', { forceRefresh: true });
    eq(warmNext.data.liveOverlay.retainedRefresh.observedAt, DAY + 'T18:10:00.000Z',
      'a cohort retained on its own day keeps priority over the evidence-day view');
    eq(basis(warmNext.data), basis(cold.data), 'restart and warm process show the same plan for the same evidence');
    eq(withoutNote(await render(warmNext.data)), withoutNote(coldText), 'restart and warm process print the same Budget');

    // 4. The request clock changes nothing but the attempt receipt.
    const strip = data => { const d = structuredClone(data);
      delete d.liveOverlay.retainedRefresh.attempt; delete d.refreshTrust; return d; };
    for (const at of [NEXT + 'T07:00:30.000Z', '2026-08-22T23:00:00.000Z']) {
      const later = await serve(fresh(), lastSync(), at, { preferObservation: true });
      eq(strip(later.data), strip(cold.data), 'same evidence, different request time and process: identical document ' + at);
      eq(later.data.liveOverlay.retainedRefresh.attempt.checkedAt, at, 'the attempt receipt records the real check time');
    }

    // 5. Never published for replay: the next normal load asks the provider again.
    const Cold = fresh();
    await serve(Cold, lastSync(), NEXT + 'T18:00:00.000Z', { preferObservation: true });
    const again = await serve(Cold, lastSync(), NEXT + 'T18:01:00.000Z', { preferObservation: true });
    eq([again.calls, again.check.qualified], [7, false], 'the dated view is not replay or current evidence');

    // 6. Rows dated after the evidence day did not exist as of that day.
    const withLater = await serve(fresh(), lastSync(p => p.transactions.push({ ...p.transactions[2], id: 92999, date: NEXT, amount: 55 })),
      NEXT + 'T18:00:00.000Z', { preferObservation: true });
    eq(basis(withLater.data), basis(cold.data), 'a row dated after the evidence day is not read into the dated view');

    // 7. A genuinely invalid answer is still refused on a cold process.
    const refusals = {
      'disagreeing balance dates': lastSync(p => { p.accounts[0].balance_last_update = NEXT + 'T17:55:00.000Z'; }),
      'balances dated on two earlier days': lastSync(p => { p.accounts[1].balance_last_update = '2026-08-18T17:55:00.000Z'; }),
      'future balance date': lastSync(p => { p.accounts[0].balance_last_update = '2026-08-21T17:55:00.000Z'; }),
      'missing balance': lastSync(p => { p.accounts[1].balance = null; }),
      'undated balance': lastSync(p => { p.accounts[1].balance_last_update = null; }),
      'date-only balance (no instant to time the view)': lastSync(p => { p.accounts.forEach(a => { a.balance_last_update = DAY; }); }),
    };
    for (const [label, payload] of Object.entries(refusals)) {
      const r = await serve(fresh(), payload, NEXT + 'T18:00:00.000Z', { preferObservation: true });
      eq(unavailable(r), true, 'still refused: ' + label);
    }
    mock.mode('postedIncomplete');
    const truncated = await serve(fresh(), lastSync(), NEXT + 'T18:00:00.000Z', { preferObservation: true });
    mock.mode('ok');
    eq(unavailable(truncated), true, 'still refused: truncated transaction window');

    // 8. Newer evidence supersedes an older retained cohort; a later read never falls back to it.
    const older = fresh(), OLDER_AT = '2026-08-18T17:55:00.000Z';
    const olderPayload = lastSync(p => { p.accounts = p.accounts.map(a => ({ ...a, balance_last_update: OLDER_AT, updated_at: OLDER_AT })); });
    const held = await serve(older, olderPayload, '2026-08-18T18:10:00.000Z', { forceRefresh: true });
    eq([held.check.qualified, held.data.meta.asOf], [true, '2026-08-18'], 'older own-day cohort is retained');
    const newer = await serve(older, lastSync(), NEXT + 'T18:00:00.000Z', { preferObservation: true });
    eq(newer.data.meta.asOf, DAY, 'newer evidence-day view replaces an older retained cohort');
    mock.mode('failure');
    const afterwards = await serve(older, lastSync(), NEXT + 'T18:05:00.000Z', { preferObservation: true });
    mock.mode('ok');
    eq(!afterwards.error && afterwards.data.meta.asOf === '2026-08-18', false, 'a later failed check never shows the superseded older view');

    console.log('PASS evidence-day view: ' + checks + ' checks; own-day equivalence, restart and clock independence, refusals kept');
  } finally { Date.now = realNow; await mock.close(); threads.Worker = RealWorker; }
})().catch(error => { console.error(error); process.exitCode = 1; });
