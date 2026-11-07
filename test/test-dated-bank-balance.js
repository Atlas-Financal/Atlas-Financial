'use strict';
/* Owner decision (2026-11-07): when Lunch Money's newest bank sync is from
 * yesterday evening, show the plan built from that latest dated balance,
 * clearly labelled, instead of the fail-closed "Current plan unavailable".
 *
 * Entirely invented accounts, cents, bills and income. No data.json, raw/ or
 * derived/ reads. Independent proof is hand arithmetic on the invented
 * balances and a count of each invented occurrence in the Forecast walk:
 *   opening cash  = 83 (Bills) + 30 (Weekly) = 113, dated the balance day;
 *   a bill due today and a deposit due today each appear exactly once;
 *   any transaction dated after the balance (posted or pending) keeps safe
 *   mode, because the dated plan could only drop it;
 *   a purchase on the balance day moves the ending balance by its amount.
 * Path: live-plan.fromObservation -> Forecast.recommend -> the page's own
 * renderers (in-process, no browser). The full browser page proof is
 * test/browser-dated-bank-balance.js (CHROME_PATH=<Chromium>).
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const Live = require('../scripts/live-plan.js');
const RT = require('../scripts/refresh-trust.js');
const Forecast = require('../public/forecast.js');

const { OPENING, TODAY, BALANCE_DAY, TODAY_SYNC, LAST_EVENING, TWO_DAYS_BACK, OPENING_CASH,
  IDENTITY, world, observe } = require('./fixtures/dated-bank-balance-data');

let failures = 0;
function ok(cond, label, detail) {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

function advise(data) {
  return Forecast.recommend(data.plan, data.meta.asOf,
    { ...data.plan.defaults, ...data.liveOverlay, weeklyVariable: 0, debts: data.debts || [] });
}

function occurrences(advice, id) {
  return ((advice.sim && advice.sim.events) || []).filter(event => event.id === id);
}

function throwsWith(fn, pattern) {
  try { fn(); } catch (err) { return pattern.test(err.message) ? err.message : `wrong error: ${err.message}`; }
  return null;
}

console.log('\n=== 1. control: balances synced today keep the incumbent live path ===');
{
  const r = observe({ at: TODAY_SYNC });
  ok(r.data.liveOverlay.applied === true && r.effectiveAsOf === TODAY, 'today-dated balances apply as today');
  ok(r.data.liveOverlay.balanceDating === null, 'no dated-balance label on a same-day sync');
  ok(r.data.refreshTrust.displayState !== RT.DISPLAY_DATED, 'refresh-trust is not the dated state');
  ok(r.data.refreshTrust.balanceDating === null, 'refresh-trust carries no balance dating');
}

console.log('\n=== 2. balances from last evening\'s sync build the dated plan ===');
let dated;
{
  dated = observe({ at: LAST_EVENING });
  const overlay = dated.data.liveOverlay;
  ok(overlay.applied === true, 'overlay applies instead of safe mode');
  ok(dated.effectiveAsOf === BALANCE_DAY && dated.data.plan.opening.asOf === BALANCE_DAY
    && dated.data.meta.asOf === BALANCE_DAY, 'the opening is the balance\'s own date (Oct 13), not today');
  ok(dated.data.plan.opening.priorAsOf === OPENING, 'the dated opening still carries the canonical prior as-of');
  ok(overlay.observedAsOf === TODAY, 'the observation itself is recorded as today');
  ok(overlay.operatingPlan === Live.OPERATING_PLAN_LIVE && !overlay.operatingPlanNote,
    'not "Current plan unavailable"');
  ok(overlay.balanceDating && overlay.balanceDating.status === 'dated-latest-sync'
    && overlay.balanceDating.balanceAsOf === BALANCE_DAY && overlay.balanceDating.observedAsOf === TODAY
    && overlay.balanceDating.reason === 'bank-sync-pending' && overlay.balanceDating.maxAgeDays === 1,
    'liveOverlay names the dated balance, its day and the reason', JSON.stringify(overlay.balanceDating));
  ok(Forecast.startingCashAmount(dated.data.plan) === OPENING_CASH,
    'opening cash is the invented balances 83 + 30 by hand');
  ok(overlay.observedCash && overlay.observedCash.asOf === BALANCE_DAY
    && overlay.observedCash.accounts.every(row => row.evidenceDate === BALANCE_DAY),
    'observed cash is dated the balance day, never today');
  const trust = dated.data.refreshTrust;
  ok(trust.displayState === RT.DISPLAY_DATED, 'refresh-trust reports the dated state, not current', trust.displayState);
  ok(trust.balanceDating && trust.balanceDating.balanceAsOf === BALANCE_DAY
    && trust.balanceDating.reason === 'bank-sync-pending', 'refresh-trust names the balance day and reason');
  ok((trust.coverageLimits || []).some(row => row.id === 'balances-dated-latest-sync'),
    'the dated balance is a stated coverage limit');
  ok(RT.looksSanitized(trust), 'refresh-trust stays sanitized');
}

console.log('\n=== 3. same evidence as a refresh at the balance time: identical plan ===');
{
  // A refresh fetched at 9:40 pm on Oct 13 with the same balances is the
  // independent reference: the dated plan must be exactly that plan.
  const reference = observe({ at: LAST_EVENING, fetchedAt: '2026-10-14T04:40:00Z' });
  ok(reference.data.liveOverlay.balanceDating === null && reference.effectiveAsOf === BALANCE_DAY,
    'reference is an ordinary same-day refresh on Oct 13');
  ok(JSON.stringify(reference.data.plan) === JSON.stringify(dated.data.plan),
    'dated plan === plan a refresh at the balance time would have built');
  const a = advise(dated.data), b = advise(reference.data);
  ok(a.mode === b.mode && JSON.stringify(a.weekly) === JSON.stringify(b.weekly)
    && JSON.stringify(a.sim.events) === JSON.stringify(b.sim.events),
    'Forecast.recommend gives the same mode, weekly figure and walk');
}

console.log('\n=== 4. nothing counted twice or dropped across the balance time ===');
{
  const a = advise(dated.data);
  ok(occurrences(a, 'water').length === 1 && occurrences(a, 'water')[0].date === TODAY,
    'a bill due today is in the walk exactly once');
  ok(occurrences(a, 'giftT').length === 1 && occurrences(a, 'giftT')[0].date === TODAY,
    'a deposit due today is in the walk exactly once');
  ok(occurrences(a, 'hydroD').length === 1, 'an unposted bill due on the balance day stays due once');
  ok(occurrences(a, 'giftD').length === 0
    && dated.data.plan.opening.notReliedUponEvents.some(row => row.id === 'giftD'),
    'an unproven deposit due on the balance day is not relied upon (never added on top)');

  // Activity dated after the balance is in neither the balance nor the dated
  // plan's actuals (Forecast reads actuals through its as-of only), so any of
  // it keeps safe mode rather than silently dropping it from the figures.
  for (const [label, transactions] of [
    ['an unplanned purchase posted today', [{ id: 'buy-today', date: TODAY, amount: 25, payee: 'INVENTED GROCER' }]],
    ['an unplanned purchase pending today', [{ id: 'buy-pending', date: TODAY, amount: 25, payee: 'INVENTED GROCER', pending: true }]],
    ['a planned deposit posted today', [{ id: 'gift-today', date: TODAY, amount: -300, payee: 'INVENTED GIFT T' }]],
    ['a balance-day bill paid today', [{ id: 'hydro-late', date: TODAY, amount: 40, payee: 'INVENTED HYDRO' }]],
  ]) {
    const msg = throwsWith(() => observe({ at: LAST_EVENING, transactions }), /post-balance-activity-unrepresented/);
    ok(msg && !/wrong/.test(msg), `${label} keeps safe mode (never dropped from the figures)`, msg);
  }
  {
    const w = world({ at: LAST_EVENING, transactions: [{ id: 'buy-today', date: TODAY, amount: 25, payee: 'INVENTED GROCER' }] });
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'atlas-dated-activity-'));
    const fx = path.join(dir, 'p.json'), map = path.join(dir, 'm.json');
    fs.writeFileSync(fx, JSON.stringify(w.payload)); fs.writeFileSync(map, JSON.stringify(w.accountMap));
    const out = Live.serveCanonicalOrFixture(w.canonical, { ATLAS_LIVE_OVERLAY: 'fixture',
      ATLAS_LIVE_OVERLAY_FIXTURE: fx, ATLAS_LIVE_OVERLAY_MAP: map });
    ok(out.liveOverlay.applied === false && out.liveOverlay.reason === 'post-balance-activity-unrepresented'
      && out.liveOverlay.operatingPlan === Live.OPERATING_PLAN_UNAVAILABLE
      && (out.refreshTrust.coverageLimits || []).some(row => row.id === 'post-balance-activity-unrepresented'),
      'served: later activity gives safe mode with a named, explained reason', out.liveOverlay.reason);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Spending on the balance day itself is inside the dated plan's window and
  // moves the figures exactly as a refresh at the balance time would.
  const SPEND = 25;
  const spendOnD = [{ id: 'buy-d', date: BALANCE_DAY, amount: SPEND, payee: 'INVENTED GROCER' }];
  const withSpend = observe({ at: LAST_EVENING, transactions: spendOnD });
  const refSpend = observe({ at: LAST_EVENING, fetchedAt: '2026-10-14T04:40:00Z', transactions: spendOnD });
  const ending = r => advise(r.data).defaultView && advise(r.data).defaultView.predictedEndingBalance;
  const base = ending(dated), spent = ending(withSpend);
  ok(Number.isFinite(base) && Number.isFinite(spent) && Math.abs((base - spent) - SPEND) < 0.005,
    `a ${SPEND} purchase on the balance day lowers the predicted ending balance by ${SPEND} by hand`, `${base} -> ${spent}`);
  ok(spent === ending(refSpend), 'and equals what a refresh at the balance time shows');

  const postedInBalance = observe({ at: LAST_EVENING, transactions: [
    { id: 'gift-in', date: BALANCE_DAY, amount: -200, payee: 'INVENTED GIFT D' },
    { id: 'hydro-in', date: BALANCE_DAY, amount: 40, payee: 'INVENTED HYDRO' }] });
  const q = advise(postedInBalance.data);
  const repIn = postedInBalance.data.plan.opening.representedEvents.map(row => row.id);
  ok(repIn.includes('giftD') && repIn.includes('hydroD'), 'postings on the balance day are inside the balance');
  ok(occurrences(q, 'giftD').length === 0 && occurrences(q, 'hydroD').length === 0,
    'and are not counted a second time in the walk');
  ok(occurrences(q, 'water').length === 1 && occurrences(q, 'giftT').length === 1,
    'today\'s bill and deposit are still counted once');
}

console.log('\n=== 5. anything else keeps safe mode exactly as before ===');
{
  const mixed = throwsWith(() => observe({ dates: { 9101: LAST_EVENING, 9102: TODAY_SYNC } }),
    /stale-live-cash-evidence/);
  ok(mixed && !/wrong/.test(mixed), 'mixed balance dates (one sync each) fail closed', mixed);
  const mixedOld = throwsWith(() => observe({ dates: { 9101: LAST_EVENING, 9102: TWO_DAYS_BACK } }),
    /stale-live-cash-evidence/);
  ok(mixedOld && !/wrong/.test(mixedOld), 'two different earlier dates fail closed', mixedOld);
  const old = throwsWith(() => observe({ at: TWO_DAYS_BACK }), /stale-live-cash-evidence: .* dated 2026-10-12/);
  ok(old && !/wrong/.test(old), 'a balance two household days old fails closed', old);
  const missing = throwsWith(() => observe({ dates: { 9102: 'omit' }, at: LAST_EVENING }),
    /live-cash-evidence/);
  ok(missing && !/wrong/.test(missing), 'a missing balance date on one account fails closed', missing);
  const bad = throwsWith(() => observe({ dates: { 9101: 'not-a-date' }, at: LAST_EVENING }),
    /live-cash-evidence/);
  ok(bad && !/wrong/.test(bad), 'an unknown balance date fails closed', bad);
  const w = world({ at: LAST_EVENING });
  w.canonical.plan.opening.asOf = BALANCE_DAY;
  w.canonical.meta.asOf = BALANCE_DAY;
  const atOpening = throwsWith(() => Live.fromObservation({ data: w.canonical, payload: w.payload,
    accountMap: w.accountMap, identity: IDENTITY }), /stale-live-cash-evidence/);
  ok(atOpening && !/wrong/.test(atOpening), 'a dated balance that does not advance past the opening fails closed', atOpening);
  // Lead requirement: a FUTURE-dated balance is never the latest update.
  const TOMORROW = '2026-10-15T18:00:00Z';
  const future = throwsWith(() => observe({ at: TOMORROW }), /live-cash-evidence/);
  ok(future && !/wrong/.test(future), 'a future-dated cash balance (all accounts) fails closed', future);
  const futureMixed = throwsWith(() => observe({ dates: { 9101: TOMORROW }, at: LAST_EVENING }),
    /live-cash-evidence/);
  ok(futureMixed && !/wrong/.test(futureMixed), 'one future-dated account beside last evening\'s fails closed', futureMixed);
  {
    const w = world({ at: TOMORROW });
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'atlas-dated-future-'));
    const fx = path.join(dir, 'p.json'), map = path.join(dir, 'm.json');
    fs.writeFileSync(fx, JSON.stringify(w.payload)); fs.writeFileSync(map, JSON.stringify(w.accountMap));
    const out = Live.serveCanonicalOrFixture(w.canonical, { ATLAS_LIVE_OVERLAY: 'fixture',
      ATLAS_LIVE_OVERLAY_FIXTURE: fx, ATLAS_LIVE_OVERLAY_MAP: map });
    ok(out.liveOverlay.applied === false && !out.liveOverlay.balanceDating
      && out.liveOverlay.operatingPlan === Live.OPERATING_PLAN_UNAVAILABLE
      && out.refreshTrust.displayState !== RT.DISPLAY_DATED,
      'served: a future-dated balance renders no plan and no latest-update label', out.liveOverlay.reason);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  ok(Live.DATED_BALANCE_MAX_AGE_DAYS === 1, 'the age bound is one named constant (one household day, under 48 hours)');
}

console.log('\n=== 6. the server path: dated plan served, fail closed otherwise ===');
{
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-dated-balance-'));
  const write = (name, value) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  const good = world({ at: LAST_EVENING });
  const env = { ATLAS_LIVE_OVERLAY: 'fixture', ATLAS_LIVE_OVERLAY_FIXTURE: write('dated.json', good.payload),
    ATLAS_LIVE_OVERLAY_MAP: write('map.json', good.accountMap) };
  const out = Live.serveCanonicalOrFixture(good.canonical, env);
  ok(out.liveOverlay && out.liveOverlay.applied === true && out.liveOverlay.balanceDating
    && out.liveOverlay.balanceDating.balanceAsOf === BALANCE_DAY, 'the server serves the dated plan');
  const stale = world({ at: TWO_DAYS_BACK });
  const outStale = Live.serveCanonicalOrFixture(stale.canonical, { ...env,
    ATLAS_LIVE_OVERLAY_FIXTURE: write('old.json', stale.payload) });
  ok(outStale.liveOverlay && outStale.liveOverlay.applied === false
    && /stale-live-cash-evidence/.test(String(outStale.liveOverlay.reason))
    && outStale.liveOverlay.operatingPlan === Live.OPERATING_PLAN_UNAVAILABLE,
    'a too-old balance still serves safe mode with the incumbent reason');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== 7. the page\'s own renderers (in-process, no browser): dated label, informational note ===');
{
  // Real public/*.js loaded into a VM, exactly as the other npm-test render
  // suites do. The full browser page proof is test/browser-dated-bank-balance.js.
  const vm = require('vm');
  const ROOT = path.join(__dirname, '..');
  function pageContext() {
    const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
    const ctx = vm.createContext({ Forecast, console, setTimeout, clearTimeout, addEventListener() {},
      document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
      localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
    ctx.window = ctx; ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
    for (const script of ['app', 'bill-detail', 'savings-inventory', 'budget-surface', 'plan']) {
      if (script === 'bill-detail') vm.runInContext('App.boot=()=>{};', ctx);
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', script + '.js'), 'utf8'), ctx);
    }
    return ctx;
  }
  function renderAll(data) {
    const ctx = pageContext();
    ctx.d = data;
    ctx.adv = advise(data);
    return vm.runInContext(`({
      card: budgetTodayCashCardHtml({ advice: adv, liveOverlay: d.liveOverlay }),
      trust: refreshTrustHtml(d.refreshTrust),
      status: formatObservationCheck(null, d.refreshTrust),
      chip: formatSiteAsOfChip(d, null),
      glance: glanceUpdatedNote(d.meta.asOf, d.liveOverlay),
    })`, ctx);
  }
  function chequingNote(data) {
    const Headline = require('../public/chequing-headline.js');
    const Chequing = require('../public/forecast-chequing.js');
    const node = () => ({ textContent: '', className: '', querySelector() { return null; }, appendChild() {} });
    const label = node(), value = node(), notes = [];
    const fact = { querySelector: sel => sel === 'span' ? label : sel === 'strong' ? value
      : sel === '.chequing-capacity-note' ? notes[0] || null : null,
    appendChild: n => notes.push(n) };
    const doc = { createElement: () => node(), getElementById: () => ({ querySelector: sel =>
      sel === '.cash-flow-top .cash-flow-fact' ? fact : null }) };
    const withOverdraft = Object.assign({}, data, { revolvingExtra: [{ id: 'invented-od', cash: 'chequing-b', limit: 100 }] });
    Headline.apply(doc, withOverdraft, Chequing);
    return notes[0] ? notes[0].textContent : '';
  }
  const d = renderAll(dated.data);
  ok(/data-balance-as-of="2026-10-13"/.test(d.card)
    && /Balances as of October 13 · next bank sync pending/.test(d.card)
    && /<h2>Balance at latest bank sync<\/h2>/.test(d.card),
    'Budget cash card: "Balances as of October 13 · next bank sync pending", titled "Balance at latest bank sync"');
  ok(!/>Today ·/.test(d.card) && !/<h2>Current balance<\/h2>/.test(d.card), 'the card never says "Today" or "Current balance"');
  ok(/data-refresh-trust-state="dated-latest-update"/.test(d.trust) && /data-balance-as-of="2026-10-13"/.test(d.trust)
    && /Latest update/.test(d.trust) && /Balances as of October 13 · next bank sync pending\./.test(d.trust),
    'trust note reads "Latest update · Balances as of October 13 · next bank sync pending"');
  ok(!/class="refresh-trust warn"/.test(d.trust) && !/Attention needed/.test(d.trust),
    'trust note is informational: no warning tone, no "Attention needed"');
  ok(/Financial coverage: latest bank sync, not today's balances\./.test(d.status), 'coverage line names the latest bank sync', d.status);
  ok(/Balances as of October 13 · next bank sync pending/.test(d.chip) && !/live balances observed/i.test(d.chip),
    'as-at chip names the balance day, never a live observation today', d.chip);
  ok(/^Latest bank sync balance\. Not credit\. As of October 13; next bank sync pending\.$/.test(d.glance), 'glance note', d.glance);
  const note = chequingNote(dated.data);
  ok(/^Chequing balances as of October 13 \(latest bank sync, not today\)/.test(note), 'chequing note names the sync day', note);

  const t = renderAll(observe({ at: TODAY_SYNC }).data);
  ok(/>Today · October 14</.test(t.card) && /<h2>Current balance<\/h2>/.test(t.card) && !/data-balance-as-of/.test(t.card + t.trust)
    && !/next bank sync pending|latest bank sync/.test(t.card + t.trust + t.status + t.chip + t.glance),
    'control: a same-day sync renders the incumbent labels and no dated wording');
  ok(/^Actual chequing balances/.test(chequingNote(observe({ at: TODAY_SYNC }).data)), 'control: incumbent chequing note');
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll dated bank balance checks passed.');
process.exit(failures ? 1 : 0);
