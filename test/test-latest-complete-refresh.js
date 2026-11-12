'use strict';
// Invented provider/household inputs only. Node proof never requires Playwright.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const Fixture = require('./fixtures/budget-surface-data');
const Memory = require('../scripts/server-observation-memory');
const Live = require('../scripts/live-plan');
const F = require('../public/forecast');
const Assistant = require('../scripts/assistant-packet');
// Clearly invented re-login inputs, following the existing test-fixture convention.
const RELOGIN_PASSWORD = 'synthetic-new-session';
const RELOGIN_SECRET = 'synthetic-new-auth-context';
let checks = 0;
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const yes = (actual, label) => { assert.ok(actual, label); checks++; };
const complete = Fixture.served();
const original = structuredClone(complete);
const evidence = { schema: Memory.SCHEMA, payload: { ...Fixture.payload(), tags: [] } };
const checkedAt = evidence.payload.fetchedAt;
const display = { context: 'synthetic-budget-and-mapping-A', data: complete, checkedAt };
const failure = { source: 'provider', qualified: false, checkedAt: null,
  attemptedAt: '2026-08-21T07:02:00.000Z', reason: 'provider-unavailable' };
const memory = Memory.create();
eq(memory.readDisplay(display.context), null, 'no complete cohort means no display fallback');
const incompleteDisplay = structuredClone(complete);
incompleteDisplay.liveOverlay.currentPeriodActuals.transactionCoverage = 'incomplete';
incompleteDisplay.plan.startingCash.breakdown[0].value += 777;
const coldMemory = Memory.create();
coldMemory.publish('strict-incomplete', evidence, { ...display, data: incompleteDisplay });
eq(coldMemory.readDisplay(display.context), null, 'a source-qualified incomplete packet cannot become the first complete display');
yes(coldMemory.read('strict-incomplete'), 'source evidence retention remains separate from display-cohort admission');
for (const stamp of ['truncated', null, undefined, 'unknown', { complete: true }]) {
  const candidate = structuredClone(complete);
  candidate.liveOverlay.currentPeriodActuals.transactionCoverage = stamp;
  eq(Memory.completeTransactionCohort(candidate), false, 'only the observer\'s explicit complete stamp admits a cohort');
}
memory.publish('strict-day-A', evidence, display);
memory.publish('strict-incomplete', evidence, { ...display, data: incompleteDisplay });
eq(memory.readDisplay(display.context).data, complete, 'an incomplete candidate cannot replace or erase the previous complete cohort');
memory.publish('strict-day-A', evidence, display);
memory.clearCurrent();
eq(memory.read('strict-day-A'), null, 'current eligibility can be retired independently');
eq(memory.readDisplay(display.context).data, complete, 'whole display survives current invalidation');
memory.noteAttempt(display.context, failure);
const held = memory.readDisplay(display.context);
const dated = Live.withLatestCompleteRefresh(held);
eq(held.checkedAt, checkedAt, 'failed attempt does not retimestamp complete observation');
eq(dated.meta, complete.meta, 'financial as-of never promoted at midnight');
eq(dated.plan, complete.plan, 'opening, actuals-derived plan and represented events kept coherent');
eq(dated.debts, complete.debts, 'whole debt/pending cohort preserved');
eq(dated.liveOverlay.currentPeriodActuals, complete.liveOverlay.currentPeriodActuals, 'no partial/current transaction blending');
eq(dated.liveOverlay.retainedRefresh.attempt, failure, 'failed current attempt distinct from old evidence');
eq(dated.refreshTrust.displayState, 'attention-needed', 'retained coverage never claims current');
eq(complete, original, 'projection never mutates complete cohort');
held.data.plan.startingCash.breakdown[0].value = 99999;
eq(memory.readDisplay(display.context).data, complete, 'display reads clone the complete cohort');
const opts = data => ({ debts: data.debts, extraFacilities: data.revolvingExtra,
  currentPeriodActuals: data.liveOverlay.currentPeriodActuals,
  operatingPlan: data.liveOverlay.operatingPlan });
eq(F.recommend(dated.plan, dated.meta.asOf, opts(dated)), F.recommend(complete.plan, complete.meta.asOf, opts(complete)),
  'Forecast recommendation unchanged on the original complete financial basis');
// Hand arithmetic from invented source inputs, not Forecast self-comparison.
eq(dated.plan.startingCash.breakdown.filter(r => r.id === 'chequing-a' || r.id === 'chequing-b')
  .reduce((sum, r) => sum + r.value, 0), 1215 + 160, 'independent complete chequing stocks');
eq(Math.round((212.40 + 74.20 + 38.75 + 96.15 + 22.99) * 100) / 100, 444.49, 'independent source purchase total');
const unknownCanonical = Fixture.canonical();
unknownCanonical.plan.bills.find(r => r.id === 'internet').amount = null;
const unknown = Live.fromObservation({ data: unknownCanonical, payload: Fixture.payload(), accountMap: Fixture.map, identity: Fixture.identity }).data;
const unknownDated = Live.withLatestCompleteRefresh({ data: unknown, checkedAt }, failure);
eq(F.scheduledAmountState(unknownDated.plan, Fixture.AS_OF, '2026-11-18').status, 'unavailable', 'complete cohort preserves legitimate scheduled Unknown');
eq(unknownDated.plan.bills.find(r => r.id === 'internet').amount, null, 'unknown never replaced by zero or an old valid amount');
eq(unknownDated.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value, 1215, 'independently known stock remains known');
const packet = Assistant.buildPacket({ data: dated, now: failure.attemptedAt,
  sourceCheck: { check: failure, attemptedAt: failure.attemptedAt } });
eq(packet.metadata.freshness.confidence, 'dated-opening', 'assistant cannot call retained display live/current');
eq(packet.metadata.sourceCheck.outcome, 'failed', 'assistant failed check not borrowed from prior success');
eq(packet.metadata.sourceCheck.evidenceCheckedAt, null, 'failed check does not acquire retained evidence time');
eq(packet.metadata.freshness.retainedRefresh.observedAt, checkedAt, 'original complete timestamp independently disclosed');
const unsafeAttempt = Live.withLatestCompleteRefresh({ data: complete, checkedAt }, {
  ...failure, source: 'SYNTHETIC-SECRET', reason: 'SYNTHETIC-SECRET', token: 'SYNTHETIC-SECRET',
});
eq(JSON.stringify(unsafeAttempt.liveOverlay.retainedRefresh).includes('SYNTHETIC-SECRET'), false,
  'attempt projection excludes unknown reason, source and arbitrary private fields');
// Reuse the existing active Budget VM harness, not a replacement renderer.
const rendererFile = path.join(__dirname, 'test-atlas-077-malformed-amounts.js');
const source = fs.readFileSync(rendererFile, 'utf8').split('const budgetPage = createBudgetPage();')[0];
const renderer = new Module(rendererFile, module); renderer.filename = rendererFile;
renderer.paths = Module._nodeModulePaths(__dirname);
renderer._compile(source + '\nmodule.exports = { createBudgetPage, strip };', rendererFile);
const page = renderer.exports.createBudgetPage();
const oldSyncPayload = Fixture.payload();
oldSyncPayload.accounts[0].plaid_last_successful_update = '2025-08-18T18:30:00Z';
oldSyncPayload.accounts[0].last_fetch = '2026-08-20T18:00:00Z';
const oldSynced = Live.fromObservation({ data: Fixture.canonical(), payload: oldSyncPayload,
  accountMap: Fixture.map, identity: Fixture.identity }).data;
eq(oldSynced.liveOverlay.currentPeriodActuals.transactionCoverage, 'complete', 'arbitrarily old sync never blanks complete row coverage');
yes(Memory.completeTransactionCohort(oldSynced), 'age-neutral whole cohort remains retainable');
const oldSyncHtml = page.render(oldSynced), oldSyncText = renderer.exports.strip(oldSyncHtml);
yes(oldSyncHtml.includes('data-account-last-updated') && oldSyncText.includes('Last updated Aug 18, 2025'), 'real Budget footer shows the original successful-sync date and year');
yes(oldSyncText.includes('11:30 a.m.') && /PDT|GMT-7|UTC-7/.test(oldSyncText), 'footer formats the successful instant in the household timezone');
yes(!oldSyncHtml.includes('data-account-sync-caution') && !oldSyncHtml.includes('data-budget-spent-incomplete'), 'sync age creates no caution or Incomplete tag');
const noSyncData = structuredClone(oldSynced);
delete noSyncData.liveOverlay.currentPeriodActuals.lastSuccessfulSyncAt;
eq(oldSyncHtml.replace(/<p class="mutedtext" data-account-last-updated>[\s\S]*?<\/p>/, ''), page.render(noSyncData),
  'metadata changes only the small footer, never figures, trust, warnings or other markup');
const oldSyncedDated = Live.withLatestCompleteRefresh({ data: oldSynced, checkedAt }, failure);
eq(oldSyncedDated.liveOverlay.currentPeriodActuals.lastSuccessfulSyncAt, '2025-08-18T18:30:00.000Z', 'later failed attempt cannot retime the retained sync metadata');
yes(page.render(oldSyncedDated).includes('Last updated Aug 18, 2025'), 'retained Budget preserves the same Last updated line');
// OD-3 (#821, owner 2026-11-11): a dated view with a "Last updated" line shows
// that line only. Byte proof against the same cohort without sync metadata:
// the note leaves, the footer arrives, and every other byte (trust tags, the
// dated "Balance at this refresh" heading, approximate markers, Unavailable
// labels) is identical.
{
  const footer = /<p class="mutedtext" data-account-last-updated>[\s\S]*?<\/p>/;
  const note = /<p class="note-box" data-latest-complete-refresh>[\s\S]*?<\/p>/;
  for (const [label, source] of [['complete', oldSynced], ['legitimate Unknown', (() => {
    const c = Fixture.canonical(); c.plan.bills.find(r => r.id === 'internet').amount = null;
    return Live.fromObservation({ data: c, payload: oldSyncPayload, accountMap: Fixture.map, identity: Fixture.identity }).data; })()]]) {
    const withSync = Live.withLatestCompleteRefresh({ data: source, checkedAt }, failure);
    const withoutSync = structuredClone(withSync); delete withoutSync.liveOverlay.currentPeriodActuals.lastSuccessfulSyncAt;
    const footerOnly = page.render(withSync), noteOnly = page.render(withoutSync);
    yes(!footerOnly.includes('data-latest-complete-refresh') && !renderer.exports.strip(footerOnly).includes('Dated plan, not current balances'),
      label + ': a dated view with Last updated carries no dated-plan note');
    yes(footer.test(footerOnly) && !footer.test(noteOnly), label + ': the small Last updated line is the freshness signal');
    yes(note.test(noteOnly), label + ': without a Last updated line the dated note still discloses the view');
    eq(footerOnly.replace(footer, ''), noteOnly.replace(note, ''), label + ': only the note goes; every other byte is unchanged');
    yes(renderer.exports.strip(footerOnly).includes('Balance at this refresh'), label + ': the dated balance heading stays');
  }
}
const html = page.render(dated), text = renderer.exports.strip(html);
yes(html.includes('data-latest-complete-refresh'), 'actual Budget path discloses retained state');
yes(text.includes('Aug 20, 2026') && text.includes('11:00 a.m.') && /PDT|GMT-7|UTC-7/.test(text), 'original household date and time shown');
yes(text.includes('Dated plan, not current balances'), 'dated figures not sold as today fresh');
yes(text.includes('Balance at this refresh'), 'Budget balance heading dated');
yes(!text.includes('Available to fund now'), 'retained funding not claimed as now');
page.context.retainedData = dated;
const chip = vm.runInContext('formatSiteAsOfChip(retainedData, null)', page.context);
yes(chip.includes('latest complete refresh') && chip.includes('Aug 20, 2026') && !chip.includes('live Lunch Money overlay'), 'site chip dates retained data rather than live chrome');
const earlierYear = vm.runInContext("formatCompleteRefreshTime('2025-08-20T18:00:00.000Z')", page.context);
yes(earlierYear.includes('2025') && !earlierYear.includes('2026'), 'no age cap copy includes the original earlier year');
const firstHour = vm.runInContext("formatCompleteRefreshTime('2025-11-02T08:30:00.000Z')", page.context);
const repeatedHour = vm.runInContext("formatCompleteRefreshTime('2025-11-02T09:30:00.000Z')", page.context);
yes(firstHour !== repeatedHour && /PDT|GMT-7|UTC-7/.test(firstHour) && /PST|GMT-8|UTC-8/.test(repeatedHour), 'Vancouver repeated DST hour has unambiguous original zone/offset');


eq(memory.readDisplay('synthetic-different-household-or-map'), null, 'incompatible household/mapping cannot borrow cohort');
eq(memory.readDisplay(display.context).data, complete, 'incompatible failed read never erases the complete cohort');
async function controllerProof() {
  const threads = require('node:worker_threads'), RealWorker = threads.Worker, exits = [], workers = [];
  threads.Worker = class extends RealWorker {
    constructor(...args) { super(...args); workers.push(this); exits.push(new Promise(resolve => this.once('exit', resolve))); }
  };
  const helpers = require('./test-server-observation-memory');
  const Refresh = require('../scripts/server-live-refresh');
  const drain = () => Promise.all(exits);
  const mock = await helpers.provider({ accountId: 501 });
  const env = helpers.environment(mock.base), canonical = Fixture.canonical();
  const originalNow = Date.now; let now = helpers.CLOCK;
  Date.now = () => Date.parse(now);
  const read = async (source = env, options = {}) => {
    let check;
    const data = await Refresh.serve(canonical, source, { ...options, onCheck(value) { check = value; } });
    await drain(); return { data, check };
  };
  const seed = async () => {
    now = helpers.CLOCK; mock.account(501); mock.mode('ok'); mock.payload({ ...Fixture.payload(), tags: [] });
    return read();
  };
  const sameCohort = (actual, warm, label) => {
    eq(actual.data.plan, warm.data.plan, label + ': whole complete plan');
    eq(actual.data.debts, warm.data.debts, label + ': whole debt/pending cohort');
    eq(actual.data.liveOverlay.currentPeriodActuals, warm.data.liveOverlay.currentPeriodActuals, label + ': whole actuals cohort');
    eq(actual.data.liveOverlay.retainedRefresh.observedAt, helpers.CLOCK, label + ': original date/time');
    eq(actual.check.qualified, false, label + ': no current qualification');
  };
  try {
    // The source receipt can qualify while downstream transaction evidence is
    // incomplete. Neither provider nor replay can install that packet as a
    // complete display, even on a cold process.
    const coldIncomplete = { ...Fixture.payload(), tags: [] };
    coldIncomplete.accounts[0].status = 'error';
    mock.payload(coldIncomplete);
    const cold = await read(env, { preferObservation: true });
    eq(cold.check.qualified, true, 'source qualification remains independent on a cold incomplete packet');
    eq(cold.data.liveOverlay.currentPeriodActuals.transactionCoverage, 'incomplete', 'cold packet preserves the evidence failure');
    eq(cold.data.liveOverlay.operatingPlan, 'unavailable', 'cold incomplete observation cannot supply a complete operating cohort');
    eq(cold.data.liveOverlay.retainedRefresh, undefined, 'cold incomplete observation invents no retained cohort');
    const coldCalls = mock.calls.length, coldReplay = await read(env, { preferObservation: true });
    eq(mock.calls.length, coldCalls, 'source-qualified cold replay makes no new provider request');
    eq(coldReplay.data.liveOverlay.operatingPlan, 'unavailable', 'cold memory replay cannot bypass cohort admission');
    eq(coldReplay.data.liveOverlay.retainedRefresh, undefined, 'cold replay cannot relabel incomplete evidence complete');
    const usableOld = { ...Fixture.payload(), tags: [] };
    usableOld.accounts[0].plaid_last_successful_update = '2025-08-18T18:30:00Z';
    usableOld.accounts[0].last_fetch = '2026-08-20T18:00:00Z';
    mock.payload(usableOld);
    const oldSuccess = await read(env, { forceRefresh: true });
    eq(oldSuccess.check.qualified, true, 'old successful contact is source-qualified');
    eq(oldSuccess.data.liveOverlay.currentPeriodActuals.transactionCoverage, 'complete', 'old successful contact does not withhold the operating plan');
    yes(oldSuccess.data.liveOverlay.operatingPlan !== 'unavailable', 'arbitrarily old sync keeps figures available');
    eq(oldSuccess.data.liveOverlay.currentPeriodActuals.lastSuccessfulSyncAt, '2025-08-18T18:30:00.000Z', 'provider path uses success, not newer request acceptance');
    const beforeReplay = mock.calls.length;
    const oldReplay = await read(env, { preferObservation: true });
    eq(mock.calls.length, beforeReplay, 'old-sync source replay makes no provider request');
    eq(oldReplay.data.liveOverlay.currentPeriodActuals, oldSuccess.data.liveOverlay.currentPeriodActuals, 'replay preserves whole cohort and original sync metadata');
    mock.mode('failure');
    const heldOldSuccess = await read(env, { forceRefresh: true });
    sameCohort(heldOldSuccess, oldSuccess, 'old-sync cohort retained on later genuine failure');
    eq(heldOldSuccess.data.liveOverlay.currentPeriodActuals.lastSuccessfulSyncAt, '2025-08-18T18:30:00.000Z', 'failed provider refresh cannot advance Last updated');
    for (const [label, mutate] of [
      ['failed sync', p => { p.accounts[0].status = 'error'; }],
      ['cash currency', p => { p.transactions[2].currency = 'usd'; }],
      ['posted conflict', p => { p.transactions.push({ ...p.transactions[2], amount: p.transactions[2].amount + 1 }); }],
      ['unreconciled split', p => p.transactions.push(
        { ...p.transactions[2], id: 99200, amount: 100, is_group: true },
        { ...p.transactions[2], id: 99201, amount: 30, parent_id: 99200 },
        { ...p.transactions[2], id: 99202, amount: 50, parent_id: 99200 })],
    ]) {
      const whole = await seed(), partial = { ...Fixture.payload(), tags: [] };
      partial.accounts[0].balance += 777; mutate(partial); mock.payload(partial);
      const laterEnv = { ...env, ATLAS_LIVE_OVERLAY_NOW: '2026-08-20T19:00:00.000Z' };
      let sourceCheck;
      const source = await Live.applyForServer(canonical, laterEnv, { onObservation(value) { sourceCheck = value; } });
      eq(sourceCheck.qualified, true, label + ': existing source receipt still qualifies');
      eq(source.liveOverlay.currentPeriodActuals.transactionCoverage, 'incomplete', label + ': downstream evidence is incomplete');
      eq(source.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value, 1215 + 777,
        label + ': rejected candidate really carries the different invented source stock');
      const retained = await read(laterEnv, { forceRefresh: true });
      sameCohort(retained, whole, label + ': whole cohort retained');
      eq(retained.check.checkedAt, laterEnv.ATLAS_LIVE_OVERLAY_NOW, label + ': failed current check keeps its own later timestamp');
      eq(retained.data.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value, 1215,
        label + ': retained stock independently matches the earlier complete source');
      mock.mode('failure'); sameCohort(await read(env, { forceRefresh: true }), whole, label + ': later failure cannot reveal a poisoned cohort');
    }
    // Unknown outside transaction coverage is legitimate content of a complete
    // cohort, not a reason to fall back to a less cautious earlier plan.
    for (const unknownKind of ['scheduled amount', 'card backing']) {
      await seed(); const unknownCanonical = Fixture.canonical();
      if (unknownKind === 'scheduled amount') unknownCanonical.plan.bills.find(row => row.id === 'internet').amount = null;
      else delete unknownCanonical.plan.cardPurchaseCoverage;
      let check;
      const currentUnknown = await Refresh.serve(unknownCanonical, env, { onCheck(value) { check = value; } }); await drain();
      eq(check.qualified, true, unknownKind + ': source remains qualified');
      eq(currentUnknown.liveOverlay.currentPeriodActuals.transactionCoverage, 'complete', unknownKind + ': transaction coverage is complete');
      mock.mode('failure');
      const datedUnknown = await Refresh.serve(unknownCanonical, env); await drain();
      yes(datedUnknown.liveOverlay.retainedRefresh, unknownKind + ': legitimate Unknown cohort remains retainable');
      eq(datedUnknown.plan, currentUnknown.plan, unknownKind + ': no earlier plan or invented zero replaces Unknown');
      if (unknownKind === 'scheduled amount') eq(datedUnknown.plan.bills.find(row => row.id === 'internet').amount, null, 'scheduled Unknown remains null');
      else eq(datedUnknown.plan.cardPurchaseCoverage, undefined, 'unknown card backing is not invented');
    }
    // STALE FIRST. The failed packet contains visibly different values; none
    // can enter the earlier complete display packet.
    const warm = await seed();
    const stale = { ...Fixture.payload(), tags: [] };
    stale.accounts = stale.accounts.map(a => ({ ...a, balance: a.balance + 777, balance_last_update: '2026-08-19T17:55:00.000Z' }));
    mock.payload(stale); sameCohort(await read(env, { forceRefresh: true }), warm, 'stale evidence');
    const count = mock.calls.length, reused = await read(env, { preferObservation: true });
    sameCohort(reused, warm, 'repeat failed display');
    eq(mock.calls.length, count, 'failed display read does not hide failure behind a fresh provider success');
    eq(reused.check.checkedAt, helpers.CLOCK, 'current stale answer keeps its own evidence timestamp');
    // OD-4 (#821): after a failed check, an ordinary page load asks the
    // provider again once the retry gap has passed, so a new bank sync shows
    // without pressing Refresh. Inside the gap, page loads make no request.
    // Fixed canonical and environment throughout (one context key, as in
    // production); only the controller clock moves (Atlas review 6787237992).
    {
      const gap = Refresh.FAILED_CHECK_RETRY_GAP_MS;
      eq(gap, 5 * 60 * 1000, 'retry gap is five minutes');
      const seeded = await seed(), t0 = Date.parse(helpers.CLOCK);
      const at = ms => { now = new Date(t0 + ms).toISOString(); };
      const step = async (ms, options) => { at(ms); const before = mock.calls.length;
        const r = await read(env, options).catch(error => ({ error }));
        return { ...r, calls: mock.calls.length - before }; };
      const chequingA = r => r.data.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value;
      mock.mode('failure');
      const forced = await step(0, { forceRefresh: true });
      yes(forced.calls >= 1, 'a forced Refresh during an outage asks the provider');
      const inside = await step(gap - 1000, { preferObservation: true });
      eq(inside.calls, 0, 'inside the retry gap a page load does not ask the provider');
      sameCohort(inside, seeded, 'inside the retry gap');
      const retry1 = await step(gap, { preferObservation: true });
      yes(retry1.calls >= 1, 'after the gap an ordinary load asks the provider (automatic retry)');
      eq(retry1.check?.qualified === true, false, 'a failed automatic retry is never shown as a qualified check');
      const inside2 = await step(2 * gap - 1000, { preferObservation: true });
      eq(inside2.calls, 0, 'the automatic failure starts a new gap');
      eq(inside2.check?.qualified === true, false, 'old qualified source evidence is not replayed after a failed automatic retry');
      const retry2 = await step(2 * gap, { preferObservation: true });
      yes(retry2.calls >= 1, 'consecutive failures: the next eligible load still asks the provider');
      eq(retry2.check?.qualified === true, false, 'consecutive failure stays unqualified, never source replay');
      // The provider recovers and the bank has synced: chequing-a moves by +300 (invented).
      const synced = { ...Fixture.payload(), tags: [] }; synced.accounts[0].balance += 300;
      mock.mode('ok'); mock.payload(synced);
      at(3 * gap); const before = mock.calls.length;
      const loads = await Promise.all([1, 2, 3].map(() => read(env, { preferObservation: true })));
      eq(mock.calls.length - before, 7, 'after recovery, concurrent ordinary loads share one coalesced provider check');
      for (const load of loads) {
        eq(load.check.qualified, true, 'after recovery an ordinary load shows the new qualified check');
        eq(load.data.liveOverlay.retainedRefresh, undefined, 'the new sync is current, not the retained cohort');
        // Hand arithmetic from the invented source, not a Forecast self-comparison.
        eq(chequingA(load), 1215 + 300, 'the new sync appears without pressing Refresh');
      }
      const replay = await step(3 * gap + 1000, { preferObservation: true });
      eq([replay.calls, replay.check.source, chequingA(replay)], [0, 'memory', 1215 + 300], 'a qualified publish releases the hold: replay of the new evidence resumes');
      // A failed check timed after the controller clock (clock skew) never latches the retained view.
      mock.mode('failure'); await step(3 * gap + 120000, { forceRefresh: true });
      mock.mode('ok');
      const skewed = await step(3 * gap + 60000, { preferObservation: true });
      yes(skewed.calls >= 1, 'a failed check dated after the request clock is not recent');
      now = helpers.CLOCK;
    }
    for (const mode of ['postedIncomplete', 'incomplete', 'laterFailure', 'failure']) {
      const fresh = await seed(); mock.mode(mode);
      const retained = await read(env, { forceRefresh: true });
      sameCohort(retained, fresh, mode);
      if (mode.endsWith('Failure') || mode === 'failure') eq(retained.check.checkedAt, null, mode + ': failed attempt has no evidence timestamp');
      yes(!JSON.stringify(retained.data).includes('householdAccountId') && !JSON.stringify(retained.check).includes('householdAccountId'), mode + ': private identity never served');
    }
    // OD-2 lead ruling (#1040, 6788227366): the same evidence re-fetched on a later
    // day is the later fetch with equal balance instants, so its evidence-day view
    // is shown. Same evidence, same plan and cohort; only the request window's
    // bounds (set by when Atlas asked) differ, and the view stays dated.
    const windowFree = actuals => { const a = structuredClone(actuals); delete a.coverageStart;
      if (a.transactionWindow) delete a.transactionWindow.startDate;
      if (a.savingsFetchCoverage) delete a.savingsFetchCoverage.startDate; return a; };
    const sameEvidence = (actual, warm, label) => {
      eq(actual.data.plan, warm.data.plan, label + ': whole complete plan');
      eq(actual.data.debts, warm.data.debts, label + ': whole debt/pending cohort');
      eq(windowFree(actual.data.liveOverlay.currentPeriodActuals), windowFree(warm.data.liveOverlay.currentPeriodActuals), label + ': same actuals cohort apart from request-window bounds');
      eq(actual.data.meta.asOf, Fixture.AS_OF, label + ': dated on the evidence day');
      eq(actual.data.liveOverlay.retainedRefresh.observedAt, '2026-08-20T17:55:00.000Z', label + ': timed by the balance evidence');
      eq(actual.check.qualified, false, label + ': no current qualification');
    };
    const dayWarm = await seed(); now = '2026-09-04T08:02:00.000Z';
    sameEvidence(await read({ ...env, ATLAS_LIVE_OVERLAY_NOW: now, SITE_PASSWORD: RELOGIN_PASSWORD, SESSION_SECRET: RELOGIN_SECRET }), dayWarm, 'no age cap, midnight and re-login');
    eq((await read({ ...env, ATLAS_LIVE_OVERLAY_NOW: now }, { preferObservation: true })).data.meta.asOf, Fixture.AS_OF, 'no new-day promotion');
    await assert.rejects(Refresh.acquireSettlement(canonical, { ...env, ATLAS_LIVE_OVERLAY_NOW: now }), e => e.code === 'live-refresh-unavailable'); checks++;
    for (const instant of ['2026-11-01T06:59:00.000Z', '2026-11-01T07:01:00.000Z', '2026-11-01T08:59:00.000Z', '2026-11-01T09:01:00.000Z']) {
      now = instant; const boundaryEnv = { ...env, ATLAS_LIVE_OVERLAY_NOW: instant };
      const boundary = await read(boundaryEnv);
      eq(boundary.data.meta.asOf, Fixture.AS_OF, 'Vancouver midnight/DST never promotes retained date');
      eq(boundary.data.liveOverlay.retainedRefresh.observedAt, '2026-08-20T17:55:00.000Z', 'Vancouver midnight/DST keeps the original evidence instant');
      await assert.rejects(Refresh.acquireSettlement(canonical, boundaryEnv), e => e.code === 'live-refresh-unavailable'); checks++;
    }
    await seed(); await Refresh.withProviderWrite(async () => ({ status: 'synthetic-no-write' })); mock.mode('laterFailure');
    const afterWrite = await read(); yes(afterWrite.data.liveOverlay.retainedRefresh, 'write generation does not erase compatible display');
    await assert.rejects(Refresh.acquireSettlement(canonical, env), e => e.code === 'live-refresh-unavailable'); checks++;
    // Pre-job failures still render dated DISPLAY; no provider job or private
    // admission is allowed through the original write/capacity barriers.
    const prejobWarm = await seed(); let releaseWrite;
    const writing = Refresh.withProviderWrite(() => new Promise(resolve => { releaseWrite = resolve; }));
    try {
      const forcedWrite = await read(env, { preferObservation: true, forceRefresh: true });
      sameCohort(forcedWrite, prejobWarm, 'forced read while provider write active');
      eq(forcedWrite.check.source, null, 'pre-job failure does not invent a provider check');
      const notStarted = Assistant.buildPacket({ data: forcedWrite.data, now: helpers.CLOCK,
        sourceCheck: { check: forcedWrite.check, attemptedAt: forcedWrite.check.attemptedAt } });
      eq(notStarted.metadata.sourceCheck.reason, 'refresh-not-started', 'pre-job receipt is unavailable, never provider success/failure');
      await assert.rejects(Refresh.acquireSettlement(canonical, env), e => e.code === 'live-refresh-invalidated'); checks++;
    } finally { releaseWrite(); await writing; }
    await seed(); mock.hold(); const capacityCalls = mock.calls.length, capacityWorkers = workers.length;
    const firstBusy = Refresh.serve(canonical, env), secondBusy = Refresh.serve({ ...canonical,
      meta: { ...canonical.meta, syntheticCapacityContext: 2 } }, env);
    try {
      await helpers.until(() => mock.calls.length >= capacityCalls + 2, 'two held workers');
      let capacityCheck;
      const atCapacity = await Refresh.serve({ ...canonical,
        meta: { ...canonical.meta, syntheticCapacityContext: 3 } }, env, { forceRefresh: true,
        onCheck(value) { capacityCheck = value; } });
      eq(atCapacity.plan, prejobWarm.data.plan, 'forced capacity failure retains whole complete plan');
      eq(capacityCheck.source, null, 'capacity refusal does not claim a provider attempt');
      eq(workers.length - capacityWorkers, 2, 'dated capacity fallback starts no third worker');
      await assert.rejects(Refresh.acquireSettlement(canonical, env), e => e.code.startsWith('live-refresh-')); checks++;
    } finally { mock.release(); await Promise.all([firstBusy, secondBusy]); await drain(); }
    // Display compatibility excludes owner schedule/labels and runtime metadata.
    const configurationWarm = await seed(); mock.mode('laterFailure');
    const changedCanonical = structuredClone(canonical);
    changedCanonical.meta.title = 'Synthetic revised title';
    changedCanonical.plan.bills[0].amount += 321;
    changedCanonical.plan.bills[0].day = 12;
    let changedCheck;
    const changed = await Refresh.serve(changedCanonical, env, { onCheck(value) { changedCheck = value; } }); await drain();
    sameCohort({ data: changed, check: changedCheck }, configurationWarm, 'canonical amount/date/label change');
    const stat = fs.statSync;
    fs.statSync = function(file, options) {
      const value = stat.call(this, file, options);
      if (options?.bigint && String(file).endsWith('server-observation-memory.js')) {
        return { ...value, mtimeNs: value.mtimeNs + 1n };
      }
      return value;
    };
    try { sameCohort(await read(), configurationWarm, 'runtime metadata change'); } finally { fs.statSync = stat; }
    // Mapping is a display condition. No partial rows from a changed category
    // assignment can be blended into the former complete cohort.
    const changedMapCanonical = structuredClone(canonical);
    changedMapCanonical.plan.budget.categories[0].from = ['Synthetic different category'];
    const incompatible = await Refresh.serve(changedMapCanonical, env); await drain();
    eq(incompatible.liveOverlay.retainedRefresh, undefined, 'changed category mapping refuses old cohort');
    // Only budget identity and mapping content gate same-process display.
    // A differing successful /me refuses A even if a later /me itself fails.
    await seed(); mock.account(502); mock.mode('laterFailure');
    const otherBudget = await read();
    eq(otherBudget.data.liveOverlay.retainedRefresh, undefined, 'different successful /me budget refuses old A');
    eq(otherBudget.data.liveOverlay.operatingPlan, 'unavailable', 'different budget failure has no compatible complete plan');
    mock.mode('failure'); eq((await read()).data.liveOverlay.retainedRefresh, undefined, 'known different budget cannot be erased by later failed /me');
    mock.account(501); mock.mode('laterFailure');
    yes((await read()).data.liveOverlay.retainedRefresh, 'same budget identity can recover untouched complete A');
    const sameProcessWarm = await seed(); mock.mode('failure');
    sameCohort(await read(), sameProcessWarm, 'failed /me under same-process production-environment assumption');
    // Official v2 account_id must be a safe integer. No user id fallback,
    // unsafe rounding or numeric-string alias is accepted as fresh identity.
    for (const id of [Number.MAX_SAFE_INTEGER + 1, '501', -1, null]) {
      mock.mode('ok'); mock.account(id); let identityCheck;
      await Live.applyForServer(canonical, env, { onObservation(value) { identityCheck = value; } });
      eq(identityCheck.householdAccountId, undefined, 'unsupported account_id never becomes budget identity: ' + typeof id);
    }
    // Older A completion cannot replace a newer B cohort or its identity.
    await seed(); mock.hold(); const beforeOld = mock.calls.length;
    const old = Refresh.serve(canonical, env).then(data => ({ data }), error => ({ error }));
    await helpers.until(() => mock.calls.length > beforeOld, 'old A provider request');
    const second = await helpers.provider({ accountId: 502 });
    try {
      const secondPayload = { ...Fixture.payload(), tags: [] };
      secondPayload.accounts.find(a => a.id === 1001).balance = 1456; second.payload(secondPayload);
      const secondEnv = helpers.environment(second.base);
      const newer = await Refresh.serve(canonical, secondEnv);
      mock.release(); const obsolete = await old; await drain();
      yes(obsolete.data?.liveOverlay.applied, 'independent valid A caller keeps its own incumbent response');
      second.mode('failure'); const keptB = await Refresh.serve(canonical, secondEnv); await drain();
      eq(keptB.plan, newer.plan, 'obsolete A cannot replace B cohort/budget identity');
      eq(keptB.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value, 1215 + 241, 'independent B stock retained');
    } finally { mock.release(); await second.close(); }
    // An older unsuccessful independent waiter can receive the newer coherent
    // SAME-budget display, but cannot rewrite that singleton's latest receipt.
    for (const failureKind of ['cash evidence', 'transaction evidence']) {
      await seed(); const oldPartial = { ...Fixture.payload(), tags: [] };
      oldPartial.accounts = oldPartial.accounts.map(a => ({ ...a, balance: a.balance + 777,
        ...(failureKind === 'cash evidence' ? { balance_last_update: '2026-08-19T17:55:00.000Z' }
          : { status: 'error' }) }));
      mock.payload(oldPartial); let oldSourceCheck;
      await Live.applyForServer(canonical, env, { onObservation(value) { oldSourceCheck = value; } });
      eq(oldSourceCheck.qualified, failureKind === 'transaction evidence', failureKind + ': source qualification is independently proven');
      mock.hold(); const beforePartial = mock.calls.length;
      let oldPartialCheck;
      const partial = Refresh.serve(canonical, env, { onCheck(value) { oldPartialCheck = value; } });
      await helpers.until(() => mock.calls.length > beforePartial, 'old partial A request');
      const newerSameBudget = await helpers.provider({ accountId: 501 });
      try {
        const freshPayload = { ...Fixture.payload(), tags: [] };
        freshPayload.accounts.find(a => a.id === 1001).balance = 1456; newerSameBudget.payload(freshPayload);
        const newestEnv = helpers.environment(newerSameBudget.base);
        const newest = await Refresh.serve(canonical, newestEnv);
        mock.release(); const partialDisplay = await partial; await drain();
        eq(partialDisplay.plan, newest.plan, 'superseded incomplete read still receives one whole latest complete cohort');
        eq(partialDisplay.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value, 1456,
          'superseded incomplete read uses the newer complete invented stock, not either older value');
        eq(oldPartialCheck.qualified, false, 'superseded incomplete waiter never claims qualified current check');
        let newestCheck;
        const newestReplay = await Refresh.serve(canonical, newestEnv, { preferObservation: true, onCheck(value) { newestCheck = value; } }); await drain();
        eq(newestReplay.liveOverlay.retainedRefresh, undefined, 'old failed attempt never contaminates newer complete singleton receipt');
        eq(newestCheck.qualified, true, 'newer complete current source eligibility unchanged by old partial completion');
      } finally { mock.release(); await newerSameBudget.close(); }
    }
    // Superseded A timeout/error/exit must never rewrite newer B's identity
    // or last-attempt receipt, even when A had already received /me identity.
    for (const stoppedBy of ['timeout', 'error', 'exit']) {
      await seed(); mock.hold('/v2/plaid_accounts'); const began = mock.calls.length, index = workers.length;
      const obsolete = Refresh.serve(canonical, env, { timeoutMs: stoppedBy === 'timeout' ? 2000 : 10000 })
        .then(data => ({ data }), error => ({ error }));
      await helpers.until(() => mock.calls.length >= began + 2, 'A /me identity before hanging later leg');
      const newestProvider = await helpers.provider({ accountId: 502 });
      try {
        const newestEnv = helpers.environment(newestProvider.base);
        const newest = await Refresh.serve(canonical, newestEnv);
        if (stoppedBy === 'error') workers[index].emit('error', new Error('SYNTHETIC-WORKER-ERROR'));
        if (stoppedBy === 'exit') await workers[index].terminate();
        const ended = await obsolete; mock.release(); await drain();
        yes(ended.error?.code?.startsWith('live-refresh-'), 'old A ' + stoppedBy + ' cannot claim newer B');
        let currentBCheck;
        const currentB = await Refresh.serve(canonical, newestEnv, { preferObservation: true,
          onCheck(value) { currentBCheck = value; } }); await drain();
        eq(currentB.liveOverlay.retainedRefresh, undefined, 'old A ' + stoppedBy + ' does not write B attempt metadata');
        eq(currentBCheck.qualified, true, 'old A ' + stoppedBy + ' leaves private-current B source qualified');
        newestProvider.mode('failure');
        const datedB = await Refresh.serve(canonical, newestEnv); await drain();
        eq(datedB.plan, newest.plan, 'B survives old A ' + stoppedBy + ' then B /me failure');
        yes(datedB.liveOverlay.retainedRefresh, 'B dated cohort still eligible after A ' + stoppedBy);
      } finally { mock.release(); await newestProvider.close(); }
    }
    // Only a later COMPLETE result replaces the whole cohort.
    await seed(); const replacement = { ...Fixture.payload(), tags: [] };
    replacement.accounts.find(a => a.id === 1001).balance = 1338;
    mock.payload(replacement); now = '2026-08-20T19:00:00.000Z';
    const laterEnv = { ...env, ATLAS_LIVE_OVERLAY_NOW: now }; const later = await read(laterEnv);
    eq(later.data.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value, 1215 + 123, 'independent later complete stock');
    mock.mode('failure'); const heldLater = await read(laterEnv);
    eq(heldLater.data.plan, later.data.plan, 'later complete replaces all prior display figures');
    eq(heldLater.data.liveOverlay.retainedRefresh.observedAt, now, 'later complete replaces original observation timestamp');
    // Actual authenticated served-data route -> actual active Budget renderer.
    now = helpers.CLOCK; mock.mode('failure'); mock.account(501);
    const site = await helpers.atlas(mock);
    try {
      const request = async force => {
        const response = await fetch(site.base + '/data.json' + (force ? '?refresh=force' : ''), { headers: { cookie: site.cookie } });
        return { response, data: await response.json() };
      };
      eq((await request(false)).response.status, 200, 'cold failed ordinary route serves unavailable packet');
      eq((await request(true)).response.status, 503, 'no complete refresh forced route stays unavailable');
      mock.mode('ok'); mock.payload({ ...Fixture.payload(), tags: [] });
      const first = await request(true); eq(first.response.status, 200, 'complete authenticated route succeeds');
      mock.mode('laterFailure'); const forced = await request(true);
      eq(forced.response.status, 200, 'failed force retains complete display rather than erasing page');
      eq(forced.response.headers.get('X-Atlas-Observation-Qualified'), 'false', 'retained response never upgrades current check');
      eq(forced.response.headers.get('X-Atlas-Observation-Checked-At'), null, 'failed route does not borrow retained evidence timestamp');
      eq(forced.data.plan, first.data.plan, 'served whole complete plan preserved');
      const beforeReload = mock.calls.length, reload = await request(false);
      eq(mock.calls.length, beforeReload, 'reload does not mask failure with a newly minted source check');
      eq(reload.data.liveOverlay.retainedRefresh.attempt, forced.data.liveOverlay.retainedRefresh.attempt, 'reload keeps true attempt receipt');
      const activeHtml = page.render(reload.data);
      yes(activeHtml.includes('data-latest-complete-refresh') && renderer.exports.strip(activeHtml).includes('Aug 20, 2026'), 'served packet reaches actual Budget dated renderer');
      eq(F.scheduledAmountState(reload.data.plan, Fixture.AS_OF, '2026-11-18').status,
        F.scheduledAmountState(first.data.plan, Fixture.AS_OF, '2026-11-18').status, 'served fallback does not strengthen Unknown gate');
      yes(!JSON.stringify(reload.data).includes('SYNTHETIC-CREDENTIAL-CANARY'), 'served data excludes provider credential');
    } finally { await site.close(); }

  } finally { Date.now = originalNow; threads.Worker = RealWorker; await mock.close(); await drain(); }
}
controllerProof().then(() => console.log('Latest complete refresh: ' + checks + ' checks passed.')).catch(error => { console.error(error.stack); process.exitCode = 1; });
