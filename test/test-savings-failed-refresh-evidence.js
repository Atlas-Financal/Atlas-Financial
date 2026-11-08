'use strict';

// G2 (#725), acceptance 2.11: a failed refresh keeps the last good dated
// Savings evidence, and the current backing it can no longer support is
// Unknown. Invented household (the acceptance harness world); no real data.
// Expected values are written by hand from the rule, not read back from the
// code under test: the carried balance is 1,000 as of 2026-10-14 (the good
// observation), and every goal's Saved is null/unknown after the failure.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./acceptance/harness');
const Live = require('../scripts/live-plan');
const Forecast = require('../public/forecast');
const { createApplication } = require('../server');

function savingsWorld(savings = 1000) {
  const w = H.baseWorld();
  w.accounts.find(a => a.id === 'savings').value = savings;
  w.commitments = [
    { id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: 'confirmed', sinkingFund: true },
    { id: 'gift', label: 'Invented gift', date: '2026-12-10', amount: 600, confidence: 'confirmed', sinkingFund: true },
  ];
  w.savingsPool = {};
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  return w;
}
const goodDoc = (savings = 1000) => H.dataOf(savingsWorld(savings)).data;
function failedDoc(canonicalAsOf) {
  const w = savingsWorld();
  w.planPatch = plan => { delete plan.savingsPoolObservation; };
  w.failRefresh = true;
  // Production shape: the failed refresh serves the canonical snapshot, which
  // is usually older than the last good live observation.
  if (canonicalAsOf) w.dataPatch = data => { data.meta.asOf = canonicalAsOf; };
  return H.dataOf(w).data;
}
// The page's own Forecast call shape (public/plan.js renderPlan).
function savingsOf(doc) {
  const o = doc.liveOverlay;
  const advice = Forecast.recommend(doc.plan, doc.meta.asOf, {
    operatingPlan: o && (o.applied === false ? 'unavailable' : o.operatingPlan),
    observedCash: o && o.observedCash,
  });
  return Forecast.savingsFundingPublication(advice.savingsFunding, { asOf: doc.meta.asOf, advice });
}
const rows = pk => pk.rows.map(r => [r.key, r.saved, r.savedTrust]);

// --- the pure function ------------------------------------------------------
{
  const good = goodDoc(), failed = failedDoc();
  assert.equal(good.liveOverlay.applied, true);
  assert.equal(failed.liveOverlay.applied, false);
  assert.deepEqual(failed.plan.savingsPoolObservation.accounts, [], 'main drops the Savings evidence on a failed refresh');
  const before = JSON.stringify([good, failed]);
  const carried = Live.withCarriedSavingsEvidence(failed, good);
  assert.equal(JSON.stringify([good, failed]), before, 'inputs are never mutated');
  const obs = carried.plan.savingsPoolObservation;
  assert.equal(obs.carried, 'last-good-refresh');
  assert.equal(obs.asOf, '2026-10-14');
  assert.deepEqual(obs.accounts.map(a => [a.accountId, a.value, a.evidenceDate, a.pendingState]),
    [['savings', 1000, '2026-10-14', 'carried'], ['savings-dont-touch', 0, '2026-10-14', 'carried']]);
  // Everything but the Savings observation is the failed document as served.
  const rest = d => { const c = structuredClone(d); delete c.plan.savingsPoolObservation; return c; };
  assert.deepEqual(rest(carried), rest(failed), 'only the Savings observation changes');
  // Returned unchanged: a good refresh, no last good, a last good that never applied.
  assert.equal(Live.withCarriedSavingsEvidence(good, good), good);
  assert.equal(Live.withCarriedSavingsEvidence(failed, null), failed);
  const notApplied = structuredClone(good); notApplied.liveOverlay.applied = false;
  assert.equal(Live.withCarriedSavingsEvidence(failed, notApplied), failed);
  // Only complete Savings evidence is retainable: an applied overlay missing
  // one or both Savings accounts is not (Atlas finding 3).
  assert.equal(Live.retainableSavingsEvidence(good), true);
  for (const keep of [['savings'], []]) {
    const partial = structuredClone(good);
    partial.plan.savingsPoolObservation.accounts = partial.plan.savingsPoolObservation.accounts.filter(a => keep.includes(a.accountId));
    assert.equal(Live.retainableSavingsEvidence(partial), false, 'incomplete Savings (' + keep.length + ' accounts) is not retainable');
    assert.equal(Live.withCarriedSavingsEvidence(failed, partial), failed, 'incomplete last good is never carried');
    // A failed refresh whose own report is incomplete is given the complete last good.
    const ownPartial = structuredClone(failed); ownPartial.plan.savingsPoolObservation = partial.plan.savingsPoolObservation;
    assert.equal(Live.withCarriedSavingsEvidence(ownPartial, good).plan.savingsPoolObservation.carried, 'last-good-refresh');
  }
  // A failed refresh with its own dated Savings report keeps its own.
  const own = structuredClone(failed); own.plan.savingsPoolObservation = structuredClone(good.plan.savingsPoolObservation);
  assert.equal(Live.withCarriedSavingsEvidence(own, good), own);
}

// --- Forecast reads carried evidence as dated, never current ----------------
{
  const good = savingsOf(goodDoc());
  assert.deepEqual(rows(good), [['commitment:trip', 600, 'calculated'], ['commitment:gift', 400, 'calculated']],
    'positive control: the good refresh backs 600 then 400');
  const carried = savingsOf(Live.withCarriedSavingsEvidence(failedDoc(), goodDoc()));
  const reported = carried.stock.reportedStock;
  assert.equal(reported.status, 'ready');
  assert.equal(reported.amount, 1000, 'the dated amount is kept');
  assert.equal(reported.balanceThrough, '2026-10-14');
  assert.equal(reported.freshness, 'carried', 'carried evidence is never current');
  assert.equal(carried.backing.status, 'unavailable');
  assert.match(carried.backing.reason, /latest refresh failed/);
  assert.deepEqual(rows(carried), [['commitment:trip', null, 'unknown'], ['commitment:gift', null, 'unknown']],
    'goal Saved is Unknown once the backing is only carried');
  // The canonical snapshot (Oct 13) is older than the carried evidence
  // (Oct 14): the dated evidence is still published, never as current.
  const older = savingsOf(Live.withCarriedSavingsEvidence(failedDoc('2026-10-13'), goodDoc()));
  assert.equal(older.stock.reportedStock.status, 'ready', 'carried evidence newer than the canonical opening stays visible');
  assert.equal(older.stock.reportedStock.amount, 1000);
  assert.equal(older.stock.reportedStock.balanceThrough, '2026-10-14');
  assert.equal(older.stock.reportedStock.freshness, 'carried');
  assert.deepEqual(rows(older), [['commitment:trip', null, 'unknown'], ['commitment:gift', null, 'unknown']]);
  // The pre-policy branch (combined policy effective after the canonical
  // date) omits reportedStock from the daily publication. The page prints
  // the dated balance from Forecast's inventory, which still carries it.
  const prePolicyFailed = failedDoc('2026-10-13');
  prePolicyFailed.plan.savingsEarmarks.allocationPolicy.effectiveFrom = '2026-10-14';
  const prePolicyGood = goodDoc();
  prePolicyGood.plan.savingsEarmarks.allocationPolicy.effectiveFrom = '2026-10-14';
  const pre = Live.withCarriedSavingsEvidence(prePolicyFailed, prePolicyGood);
  const preAdvice = Forecast.recommend(pre.plan, pre.meta.asOf, { operatingPlan: 'unavailable' });
  const inv = preAdvice.savingsInventory.reportedStock;
  assert.deepEqual([inv.status, inv.freshness, inv.amount, inv.balanceThrough], ['ready', 'carried', 1000, '2026-10-14'],
    'pre-policy: the inventory still publishes the carried dated balance the page prints');
  const prePk = Forecast.savingsFundingPublication(preAdvice.savingsFunding, { asOf: pre.meta.asOf, advice: preAdvice });
  assert.ok(prePk.rows.every(r => r.saved == null), 'pre-policy: no goal Saved is derived from carried evidence');
  // An uncarried observation dated after the plan stays refused (main's rule).
  const later = Live.withCarriedSavingsEvidence(failedDoc('2026-10-13'), goodDoc());
  delete later.plan.savingsPoolObservation.carried;
  assert.equal(savingsOf(later).stock.reportedStock.status, 'unavailable');
  // Without the carry (main's failed refresh) the evidence is simply gone.
  assert.equal(savingsOf(failedDoc()).stock.reportedStock.status, 'unavailable');
}

// --- the real server route ----------------------------------------------------
const secret = purpose => ['synthetic-only-g2', purpose, crypto.randomBytes(24).toString('hex')].join('-');
const env = { SITE_PASSWORD: secret('password'), SESSION_SECRET: secret('signature-secret') };
async function serveSequence(docs) {
  const queue = docs.slice();
  const app = createApplication({ env, baseSource: async () => structuredClone(queue.shift()) });
  const server = require('node:http').createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: env.SITE_PASSWORD }) });
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const out = [];
    for (let i = 0; i < docs.length; i++) {
      const response = await fetch(origin + '/data.json', { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      out.push(await response.json());
    }
    return out;
  } finally { await new Promise(resolve => server.close(resolve)); }
}

(async () => {
  {
    // Good, then failed: the server serves the carried dated evidence.
    const [first, second] = await serveSequence([goodDoc(), failedDoc()]);
    assert.deepEqual(first.plan.savingsPoolObservation, goodDoc().plan.savingsPoolObservation,
      'a successful refresh is served unchanged');
    const obs = second.plan.savingsPoolObservation;
    assert.equal(obs.carried, 'last-good-refresh');
    assert.equal(obs.asOf, '2026-10-14');
    assert.equal(second.liveOverlay.applied, false, 'the failed refresh stays failed');
    const pk = savingsOf(second);
    assert.equal(pk.stock.reportedStock.amount, 1000);
    assert.deepEqual(rows(pk), [['commitment:trip', null, 'unknown'], ['commitment:gift', null, 'unknown']],
      'served backing is Unknown after the failure');
  }
  {
    // Good (Oct 14), then failed against an older canonical snapshot (Oct 13).
    const [, second] = await serveSequence([goodDoc(), failedDoc('2026-10-13')]);
    assert.equal(second.meta.asOf, '2026-10-13');
    assert.equal(second.plan.savingsPoolObservation.asOf, '2026-10-14');
    const pk = savingsOf(second);
    assert.equal(pk.stock.reportedStock.amount, 1000);
    assert.equal(pk.stock.reportedStock.freshness, 'carried');
    assert.deepEqual(rows(pk), [['commitment:trip', null, 'unknown'], ['commitment:gift', null, 'unknown']]);
  }
  {
    // Good, then good: the second success is served as produced, never carried.
    const [, second] = await serveSequence([goodDoc(1000), goodDoc(1200)]);
    assert.deepEqual(second.plan.savingsPoolObservation, goodDoc(1200).plan.savingsPoolObservation);
    assert.equal(second.plan.savingsPoolObservation.carried, undefined);
    assert.deepEqual(rows(savingsOf(second)), [['commitment:trip', 600, 'calculated'], ['commitment:gift', 600, 'calculated']]);
  }
  {
    // Failed with no earlier success: unchanged (no evidence invented).
    const [only] = await serveSequence([failedDoc()]);
    assert.deepEqual(only.plan.savingsPoolObservation.accounts, []);
  }
  await realControllerCases();
  console.log('test-savings-failed-refresh-evidence: all assertions passed');
})().catch(err => { console.error(err); process.exit(1); });

// --- the real refresh controller (no substituted base source) ----------------
// The route reads the invented canonical as data.json (read-only interception
// in this process; the file is never written). A good refresh runs the real
// fixture overlay; failures run the real live controller and worker with no
// account map and no credential, so no provider is ever called.
async function realControllerCases() {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dataFile = path.join(__dirname, '..', 'data.json');
  const world = savingsWorld();
  const plan = H.planOf(world); delete plan.savingsPoolObservation;
  const canonical = H.canonicalOf(world, plan);
  const read = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (typeof file === 'string' && path.resolve(file) === dataFile) {
      const bytes = JSON.stringify(canonical);
      return args[0] ? bytes : Buffer.from(bytes);
    }
    return read.call(this, file, ...args);
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-g2-'));
  const write = (name, value) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(value)); return f; };
  const goodPayload = write('good.json', H.rawPayload(world));
  const partialWorld = savingsWorld(); partialWorld.accounts.find(a => a.id === 'savings-dont-touch').unobserved = true;
  const partialPayload = write('partial.json', H.rawPayload(partialWorld));
  const map = write('map.json', H.accountMapOf(world));
  const fixture = payload => ({ ATLAS_LIVE_OVERLAY: 'fixture', ATLAS_LIVE_OVERLAY_FIXTURE: payload, ATLAS_LIVE_OVERLAY_MAP: map });
  const failing = { ATLAS_LIVE_OVERLAY: 'live' };
  async function session(steps) {
    const env = { SITE_PASSWORD: secret('password'), SESSION_SECRET: secret('signature-secret') };
    const app = createApplication({ env });
    const server = require('node:http').createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
      const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: env.SITE_PASSWORD }) });
      assert.equal(login.status, 302);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const out = [];
      for (const [mode, query] of steps) {
        for (const k of ['ATLAS_LIVE_OVERLAY', 'ATLAS_LIVE_OVERLAY_FIXTURE', 'ATLAS_LIVE_OVERLAY_MAP']) delete env[k];
        Object.assign(env, mode);
        const response = await fetch(origin + '/data.json' + (query || ''), { headers: { Cookie: cookie } });
        out.push({ status: response.status, body: await response.json() });
      }
      return out;
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
  const carriedCheck = (r, why) => {
    assert.equal(r.status, 200, why + ': served, not 503');
    assert.equal(r.body.liveOverlay.applied, false, why + ': still a failed refresh');
    const obs = r.body.plan.savingsPoolObservation;
    assert.equal(obs.carried, 'last-good-refresh', why);
    assert.equal(obs.asOf, '2026-10-14', why);
    const pk = savingsOf(r.body);
    assert.equal(pk.stock.reportedStock.amount, 1000, why + ': the dated amount');
    assert.deepEqual(rows(pk), [['commitment:trip', null, 'unknown'], ['commitment:gift', null, 'unknown']], why + ': Saved Unknown');
  };
  try {
    {
      // Good, then Manual Refresh (forced) fails, then an ordinary load fails.
      const [good, forced, ordinary] = await session([[fixture(goodPayload)], [failing, '?refresh=force'], [failing]]);
      assert.equal(good.status, 200);
      assert.equal(good.body.liveOverlay.applied, true, 'positive control: the good refresh applied');
      assert.ok(Live.retainableSavingsEvidence(good.body), 'the good refresh holds complete Savings evidence');
      carriedCheck(forced, 'forced refresh failure');
      carriedCheck(ordinary, 'ordinary refresh failure');
    }
    {
      // Good, then a successful refresh missing one Savings account, then a
      // failure: the incomplete observation never replaces the last good one.
      const [, partial, failed] = await session([[fixture(goodPayload)], [fixture(partialPayload)], [failing, '?refresh=force']]);
      assert.equal(partial.body.liveOverlay.applied, true, 'the cash overlay applied');
      assert.equal(Live.retainableSavingsEvidence(partial.body), false, 'one Savings account is not complete evidence');
      carriedCheck(failed, 'failure after an incomplete observation');
    }
    {
      // Nothing retained: the incumbent 503 is unchanged.
      const [only] = await session([[failing, '?refresh=force']]);
      assert.equal(only.status, 503);
    }
  } finally {
    fs.readFileSync = read;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
