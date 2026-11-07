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
 * Path: live-plan.fromObservation -> Forecast.recommend -> rendered index.html.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fixture = require('./fixtures/payday-gap-reserve-data');
const shell = require('./fixtures/savings-daily-consumer-data');
const Live = require('../scripts/live-plan.js');
const RT = require('../scripts/refresh-trust.js');
const Forecast = require('../public/forecast.js');

const OPENING = '2026-09-29';
const TODAY = '2026-10-14';
const BALANCE_DAY = '2026-10-13';
const FETCHED_AT = '2026-10-14T18:00:00Z';           // Oct 14, 11:00 am Pacific
const TODAY_SYNC = '2026-10-14T17:55:00Z';           // Oct 14, 10:55 am Pacific
const LAST_EVENING = '2026-10-14T04:32:00Z';         // Oct 13, 9:32 pm Pacific
const TWO_DAYS_BACK = '2026-10-13T04:32:00Z';        // Oct 12, 9:32 pm Pacific
const OPENING_CASH = 83 + 30;                        // invented Bills + Weekly balances

let failures = 0;
function ok(cond, label, detail) {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

const IDENTITY = {
  rules: [
    { eventId: 'giftD', payeePattern: 'INVENTED GIFT D', atlasAccountId: 'chequing-a',
      direction: 'credit', postingDateRule: 'covers-due-on-or-before-posting' },
    { eventId: 'giftT', payeePattern: 'INVENTED GIFT T', atlasAccountId: 'chequing-a', direction: 'credit' },
    { eventId: 'hydroD', payeePattern: 'INVENTED HYDRO', atlasAccountId: 'chequing-a',
      direction: 'debit', postingDateRule: 'covers-due-on-or-before-posting' },
  ],
  billPaymentPayees: [],
};

// dates: one balance_last_update per invented account id, or one for all.
function world(opts = {}) {
  const i = fixture.input();
  i.asOf = i.x.asOf = TODAY;
  i.window.endDate = TODAY;
  i.plan.income.push(
    { id: 'giftD', label: 'Invented deposit due on the balance day', frequency: 'once',
      date: BALANCE_DAY, amount: 200, confidence: 'confirmed' },
    { id: 'giftT', label: 'Invented deposit due today', frequency: 'once',
      date: TODAY, amount: 300, confidence: 'confirmed' });
  i.plan.bills = (i.plan.bills || []).concat([
    { id: 'water', label: 'Invented bill due today', frequency: 'once', date: TODAY,
      amount: 50, confidence: 'confirmed', account: 'chequing-a' },
    { id: 'hydroD', label: 'Invented bill due on the balance day', frequency: 'once', date: BALANCE_DAY,
      amount: 40, confidence: 'confirmed', account: 'chequing-a' }]);
  const canonical = shell('ready');
  canonical.meta = { asOf: OPENING, title: 'Invented dated-balance review' };
  canonical.plan = i.plan;
  canonical.debts = [];
  const payload = fixture.payload(i);
  payload.fetchedAt = opts.fetchedAt || FETCHED_AT;
  for (const account of payload.accounts) {
    account.updated_at = TODAY_SYNC;
    const at = opts.dates && Object.prototype.hasOwnProperty.call(opts.dates, account.id)
      ? opts.dates[account.id] : (opts.at === undefined ? TODAY_SYNC : opts.at);
    if (at === 'omit') delete account.balance_last_update;
    else account.balance_last_update = at;
  }
  for (const tx of opts.transactions || []) {
    payload.transactions.push({ id: tx.id, account_id: 9101, date: tx.date, amount: tx.amount,
      currency: 'CAD', is_pending: tx.pending === true, payee: tx.payee });
  }
  return { canonical, payload, accountMap: i.accountMap };
}

function observe(opts) {
  const w = world(opts);
  return Live.fromObservation({ data: w.canonical, payload: w.payload, accountMap: w.accountMap, identity: IDENTITY });
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

async function pageProof() {
  console.log('\n=== 7. rendered main page (index.html): dated label, informational note ===');
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (err) {
    ok(false, 'playwright is available for the rendered-page proof', err.message);
    return;
  }
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });
  const pub = path.join(ROOT, 'public');
  const origin = 'http://dated-balance.test';
  const errors = [], external = [];
  async function render(data) {
    const page = await browser.newPage({ viewport: { width: 390, height: 1000 }, reducedMotion: 'reduce' });
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.origin !== origin) { external.push(u.origin); return route.abort(); }
      if (route.request().method() !== 'GET') return route.abort();
      if (u.pathname === '/data.json') return route.fulfill({ json: data });
      if (['/periods.json', '/balance-history.json', '/running-build.json'].includes(u.pathname)) return route.fulfill({ json: null });
      const file = path.resolve(pub, '.' + (u.pathname === '/' ? '/index.html' : u.pathname));
      if (!file.startsWith(pub + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ body: fs.readFileSync(file),
        contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto(origin + '/');
    await page.locator('[data-budget-today-cash]').first().waitFor({ state: 'attached' });
    const result = await page.evaluate(() => {
      const card = document.querySelector('[data-budget-today-cash]');
      // The full refresh-trust card is the page's own renderer; it is mounted
      // on the safe-mode surface, so render it from the served packet here.
      const holder = document.createElement('div');
      holder.innerHTML = typeof refreshTrustHtml === 'function' ? refreshTrustHtml(App.data.refreshTrust) : '';
      const aside = holder.querySelector('.refresh-trust');
      const status = Array.from(document.querySelectorAll('span.muted'))
        .map(n => n.textContent).find(t => /Financial coverage/.test(t)) || '';
      return {
        eyebrow: card ? (card.querySelector('.budget-cash-eyebrow') || {}).textContent : '',
        heading: card ? (card.querySelector('h2') || {}).textContent : '',
        cardBalanceAsOf: card && card.getAttribute('data-balance-as-of'),
        state: aside && aside.getAttribute('data-refresh-trust-state'),
        balanceAsOf: aside && aside.getAttribute('data-balance-as-of'),
        warn: !!(aside && aside.classList.contains('warn')),
        text: aside ? aside.textContent.replace(/\s+/g, ' ') : '',
        status,
        unavailable: !!document.querySelector('[data-operating-plan="unavailable"]'),
        body: document.body.innerText,
      };
    });
    await page.close();
    return result;
  }
  try {
    const d = await render(dated.data);
    ok(d.eyebrow === 'Balances as of October 13 · next bank sync pending' && d.cardBalanceAsOf === BALANCE_DAY,
      'main balance card reads "Balances as of October 13 · next bank sync pending"', d.eyebrow);
    ok(d.heading === 'Balance at latest bank sync', 'the balance is titled the latest bank sync, not "Current balance"', d.heading);
    ok(!/Today · October 1[34]/.test(d.body), 'no "Today" label is put on the dated balance');
    ok(/Financial coverage: latest bank sync, not today's balances\./.test(d.status),
      'the coverage line says latest bank sync, not today\'s balances', d.status);
    ok(d.state === 'dated-latest-update' && d.balanceAsOf === BALANCE_DAY, 'trust note is the dated latest-update state', d.state);
    ok(!d.warn, 'trust note is informational, not the warning tone');
    ok(/Latest update/.test(d.text) && /Balances as of October 13 · next bank sync pending\./.test(d.text),
      'trust note reads "Latest update · Balances as of October 13 · next bank sync pending"', d.text.slice(0, 160));
    ok(!/Attention needed/.test(d.text + d.body), 'no "Attention needed" error for a dated sync');
    ok(!d.unavailable && !/Current plan unavailable/.test(d.body), 'the plan renders; no "Current plan unavailable"');

    const s = observe({ at: TODAY_SYNC });
    const t = await render(s.data);
    ok(/^Today · October 14$/.test(t.eyebrow) && t.heading === 'Current balance' && !t.cardBalanceAsOf
      && t.state !== 'dated-latest-update' && !/next bank sync pending/.test(t.text + t.body),
      'control: a same-day sync renders the incumbent "Today" card and no dated label', t.eyebrow);
    ok(errors.length === 0, 'no page errors', errors.join(' | '));
    ok(external.length === 0, 'no external requests');
  } finally { await browser.close(); }
}

pageProof().then(() => {
  console.log(failures ? `\n${failures} failure(s)` : '\nAll dated bank balance checks passed.');
  process.exit(failures ? 1 : 0);
}).catch(err => { console.error(err); process.exit(1); });
