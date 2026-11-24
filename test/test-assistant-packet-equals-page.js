'use strict';
/* The assistant packet answers the Budget page's question (finish-line audit
 * finding 12, #821 6788704527).
 * `node test/test-assistant-packet-equals-page.js`
 *
 * Other AI tools read /assistant/current and /assistant/mcp and then advise
 * the household, so for the same served data the packet must print the
 * page's own figures and tags. Before this change the packet called Forecast
 * with different inputs (no worksheet knobs, no extraDebtTarget, no observed
 * cash or period history, overdraft facilities under a key the engine does not
 * read, and the raw rather than the PA-5 effective operating verdict), tagged
 * any non-null figure "calculated", and after a refresh rejected before any
 * household date was observed it published the committed opening as status
 * ok while the page said unavailable.
 *
 * Each case boots the real page on the served document against a stub DOM
 * and builds the real packet on the same document, spying on Forecast in
 * both. Nothing rendered or computed is printed: mismatches are reported by
 * key name only.
 *
 * Two pages still call Forecast, and the packet is compared with both: the
 * Stack page (public/stack-shell.js, the default route since B7: the shell's
 * Forecast.recommend call, which it hands to its blocks as
 * StackBlocks.context().recommendation) and the classic page's own call
 * (plan.js, with the worksheet knobs). The classic half, including the
 * budgetBreakdown parity (the Stack page does not call budgetBreakdown),
 * RETIRES AT C1 S7 with the classic page (docs/C1_TEST_DISPOSITIONS.md, lead
 * ruling: both stay until then). plan.js is loaded because it is the classic
 * page and holds planSettlementOutcome, the settlement gate the shell calls
 * (it moves out of plan.js at C1 S5, and this load line changes with it).
 * Whether the packet's printed surplus equals the waterfall's "Surplus after
 * deductions" is a separate, queued proof (Q1 in that file), not this one.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const periods = JSON.parse(read('public/periods.json'));

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const SPIED = ['recommend', 'budgetBreakdown'];

function bootPage(data) {
  const els = new Map();
  const mk = id => {
    const el = { id, textContent: '', value: '', children: [], style: {}, attributes: {}, hidden: false, checked: false,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute() {},
      appendChild(c) { return c; }, append() {}, remove() {}, insertAdjacentHTML() {}, querySelector: () => mk('q'), querySelectorAll: () => [], getBoundingClientRect: () => ({ left: 0, width: 0, top: 0, height: 0 }), scrollTo() {}, dataset: {}, scrollLeft: 0, clientWidth: 0, scrollWidth: 0 };
    let h = ''; Object.defineProperty(el, 'innerHTML', { get: () => h, set(v) { h = String(v); } });
    return el;
  };
  const get = id => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); };
  const calls = {};
  const errors = [];
  const sb = {
    document: { getElementById: get, createElement: () => mk('c'), createElementNS: () => mk('s'),
      querySelector: () => null, querySelectorAll: () => [], documentElement: mk('html'), body: { scrollHeight: 0 },
      head: { appendChild: c => c } },
    location: { pathname: '/', search: '', hash: '', href: 'http://page.invalid/' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {}, matchMedia: () => ({ addEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }), requestAnimationFrame() {},
    innerWidth: 1200, innerHeight: 800, scrollY: 0,
    console: { log() {}, warn() {}, error: (...a) => errors.push(a), info() {} },
    fetch: url => Promise.resolve({ status: 200, ok: true, json: () => (String(url).includes('periods') ? periods
      : String(url).includes('balance-history') ? null : data) }),
  };
  sb.window = sb; sb.globalThis = sb;
  Object.assign(sb, { AbortController, URLSearchParams, setTimeout, clearTimeout });
  vm.createContext(sb);
  for (const f of ['public/app.js', 'public/display-name.js', 'public/forecast-card-period.js', 'public/forecast.js']) vm.runInContext(read(f), sb, { filename: f });
  for (const fn of SPIED) {
    const orig = sb.Forecast[fn];
    // origin: which page asked, read from the caller's file (the Stack shell, or the classic page's scripts).
    sb.Forecast[fn] = function (...args) {
      const r = orig.apply(this, args);
      (calls[fn] = calls[fn] || []).push({ args, r, origin: /stack-shell\.js/.test(new Error().stack) ? 'shell' : 'classic' });
      return r;
    };
  }
  for (const f of ['public/budget-surface.js', 'public/plan.js', 'public/stack-shell.js']) vm.runInContext(read(f), sb, { filename: f });
  return new Promise(resolve => setTimeout(() => resolve({ calls, sb, errors }), 60));
}

function buildPacket(data) {
  // A fresh module graph per case so the spy wraps the Forecast the packet uses.
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(path.join(ROOT, 'public')) || k.startsWith(path.join(ROOT, 'scripts'))) delete require.cache[k];
  }
  const F = require('../public/forecast.js');
  const calls = {};
  for (const fn of SPIED) {
    const orig = F[fn];
    F[fn] = function (...args) { const r = orig.apply(this, args); (calls[fn] = calls[fn] || []).push({ args, r }); return r; };
  }
  const A = require('../scripts/assistant-packet.js');
  const packet = A.buildPacket({ data: JSON.parse(JSON.stringify(data)), periods, questionsMarkdown: '', env: {}, now: '2026-11-11T00:00:00Z' });
  return { calls, packet };
}

// Structural equality by key; reports differing key names, never values.
const canon = v => JSON.stringify(v === undefined ? '__undefined__' : v);
function diffKeys(a, b) {
  const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort();
  return keys.filter(k => canon(a && a[k]) !== canon(b && b[k]));
}
const cents = n => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100));
const activePeriod = advice => ((advice && advice.defaultView && advice.defaultView.calendarPeriods) || [])
  .find(p => p && p.id === 'this-pay-period') || null;

// Owner stop 2: no packet tag may be more certain on this change than on its
// base. CEILING is, per packet path, the most certain tag the base code
// (b32c2df) can print there, read from that code rather than from any one
// document: trustFor printed "calculated" for any non-null figure; Balance
// After Deductions carries Forecast's own calculated/estimated; the
// facility rows print calculated or unknown; the trajectory passes Forecast's
// normalSpending tag through (unavailable, estimated or calculated). A path
// the base never tagged may print at most "estimated". Any tag outside the
// known vocabulary ranks most certain, so it fails closed.
const RANK = { unknown: 0, unavailable: 0, estimated: 1, planned: 1, 'planned-unconfirmed': 1, calculated: 2 };
const rank = t => (Object.prototype.hasOwnProperty.call(RANK, t) ? RANK[t] : 3);
const CEILING = {
  'current.spendableHouseholdCash': 'calculated',
  'forecast.recommendation': 'calculated',
  'forecast.predictedEndingBalance': 'calculated',
  'current.debts.facilities[]': 'calculated',
  'planning.trajectory.normalSpending': 'calculated',
};
function packetTags(packet) {
  const out = [];
  (function walk(v, p) {
    if (Array.isArray(v)) { v.forEach(x => walk(x, p + '[]')); return; }
    if (!v || typeof v !== 'object') return;
    for (const k of Object.keys(v)) {
      if (k === 'trust' && typeof v[k] === 'string') out.push([p, v[k]]);
      else walk(v[k], p ? p + '.' + k : k);
    }
  })(packet, '');
  return out;
}
function noTagMoreCertainThanBase(packet, what) {
  const tags = packetTags(packet);
  const over = tags.filter(([p, t]) => rank(t) > rank(CEILING[p] || 'estimated'));
  ok(tags.length > 0 && over.length === 0,
    'no packet tag is more certain than its base allows — ' + what,
    over.map(([p, t]) => p + '=' + t).join(', '));
}

function invented(extra) {
  const d = require('./fixtures/savings-daily-consumer-data')();
  d.paypal = { perMonth: 37 };
  d.periodHistory = [];
  return Object.assign(d, extra || {});
}

(async () => {
  const cases = [
    ['invented household with overdraft facilities, PayPal and an applied overlay', invented()],
    ['the committed served document (data.json)', JSON.parse(read('data.json'))],
  ];
  for (const [what, data] of cases) {
    console.log(`\n=== ${what} ===`);
    const page = await bootPage(JSON.parse(JSON.stringify(data)));
    const pkt = buildPacket(data);
    const callsOf = (origin, fn) => ((page.calls[fn] || []).filter(c => c.origin === origin));
    const shellRec = callsOf('shell', 'recommend');
    ok(shellRec.length === 1, 'the Stack shell calls Forecast.recommend once');
    ok(page.errors.length === 0, 'the Stack shell ran without falling back to the classic page', String(page.errors.length));
    const shellContext = page.sb.StackBlocks && page.sb.StackBlocks.context && page.sb.StackBlocks.context();
    ok(!!shellContext && !!shellRec[0] && shellContext.recommendation === shellRec[0].r,
      'the call compared is the one the shell hands to its blocks');
    const classicRec = callsOf('classic', 'recommend');
    ok(classicRec.length >= 1, 'the classic page still calls Forecast.recommend (retires at C1 S7)');
    const aRec = pkt.calls.recommend && pkt.calls.recommend[0];
    ok(!!aRec, 'the packet calls Forecast.recommend');
    if (!shellRec[0] || !classicRec[0] || !aRec) continue;

    // The packet is compared with each page that still calls Forecast: the Stack shell (the page the household
    // reads) and the classic page's own call (with the worksheet knobs). The classic half RETIRES AT C1 S7 with the
    // classic page (docs/C1_TEST_DISPOSITIONS.md, lead ruling: both stay until then).
    const HELD_FLAG = 'collectHeldTransactions';
    const withoutHeld = advice => {
      const copy = JSON.parse(JSON.stringify(advice));
      if (copy.currentPeriodAction) delete copy.currentPeriodAction.heldTransactions;
      // recommend echoes its options; drop only the flag's own echo.
      for (const k of ['planOptions', 'simOptions']) if (copy[k]) delete copy[k][HELD_FLAG];
      return copy;
    };
    for (const [who, pRec] of [['Stack shell', shellRec[0]], ['classic page, retires at S7', classicRec[0]]]) {
      const okw = (cond, label, detail) => ok(cond, label + ' [' + who + ']', detail);
      okw(pRec.args[1] === aRec.args[1], 'the same as-of date');
      // The packet adds exactly one input, collectHeldTransactions (the held-row to-do list). It may add only
      // currentPeriodAction.heldTransactions: with that one field removed, the packet's whole recommend output
      // must equal the page's, so no figure or tag can move through it.
      const recDiff = diffKeys(pRec.args[2], aRec.args[2]).filter(k => k !== HELD_FLAG);
      okw(recDiff.length === 0, 'identical Forecast.recommend inputs', recDiff.join(', '));
      okw(aRec.args[2][HELD_FLAG] === true && !(HELD_FLAG in pRec.args[2]),
        'only the packet asks for the held-row list; the page never does');
      const outDiff = diffKeys(withoutHeld(pRec.r), withoutHeld(aRec.r));
      okw(outDiff.length === 0, 'the packet\'s recommend output equals the page\'s apart from the held-row list',
        outDiff.join(', '));
      okw(!(pRec.r.currentPeriodAction && 'heldTransactions' in pRec.r.currentPeriodAction),
        'the page\'s advice carries no held-row list');
      // The figures themselves: the packet prints what the page's advice holds.
      const rec = pkt.packet.forecast && pkt.packet.forecast.recommendation;
      okw(rec && cents(rec.weekly) === cents(pRec.r.weekly), 'the weekly recommendation equals the page\'s');
      const peb = pkt.packet.forecast && pkt.packet.forecast.predictedEndingBalance;
      const pageBad = activePeriod(pRec.r) && activePeriod(pRec.r).balanceAfterDeductions;
      okw(!peb || peb.status !== 'ok' || cents(peb.amount) === cents(pageBad),
        'Balance After Deductions equals the page\'s current pay period');
    }
    ok(!('revolvingExtra' in aRec.args[2]) && 'extraFacilities' in aRec.args[2],
      'overdraft facilities reach recommend under the key the engine reads (extraFacilities)');
    // RETIRES AT C1 S7: the Stack page does not call budgetBreakdown, so this parity is with the classic boot only.
    const pBud = callsOf('classic', 'budgetBreakdown')[0];
    const aBud = pkt.calls.budgetBreakdown && pkt.calls.budgetBreakdown[0];
    ok(!!pBud && !!aBud, 'both the classic page and the packet call Forecast.budgetBreakdown (retires at C1 S7)');
    if (pBud && aBud) {
      const budDiff = diffKeys(pBud.args[2], aBud.args[2]);
      ok(budDiff.length === 0, 'identical Forecast.budgetBreakdown inputs (paypalPerMonth, weekly basis, as-of)', budDiff.join(', '));
    }
    const rec = pkt.packet.forecast && pkt.packet.forecast.recommendation;

    // No invented or borrowed trust (#1081 6798337483): Forecast tags
    // neither of these figures, so both read unknown/not-tagged-by-Forecast.
    const cash = pkt.packet.current && pkt.packet.current.spendableHouseholdCash;
    for (const [label, row] of [['spendable household cash', cash], ['weekly recommendation', rec]]) {
      if (!row || row.status === 'unavailable') continue;
      ok(row.trust === 'unknown' && row.trustSource === 'not-tagged-by-Forecast',
        label + ' reads unknown/not-tagged-by-Forecast', String(row.trust) + '/' + String(row.trustSource));
    }
    noTagMoreCertainThanBase(pkt.packet, what);
  }

  console.log('\n=== a household whose only non-zero cash row is the Bills account (#1081 6798337483) ===');
  {
    // Invented values on the served shape: spendable household cash then
    // equals the Bills-account current-balance publication, which may be
    // "posted". That tag describes one account, not the household sum, and
    // must not be borrowed by numeric coincidence.
    const d = JSON.parse(read('data.json'));
    const rows = (d.plan && d.plan.startingCash && d.plan.startingCash.breakdown) || [];
    ok(rows.some(r => r && r.id === 'chequing-a'), 'the served shape holds the Bills account row');
    for (const r of rows) if (r) r.value = r.id === 'chequing-a' ? 1234.56 : 0;
    if (d.plan.startingCash && 'amount' in d.plan.startingCash) d.plan.startingCash.amount = 1234.56;
    const pkt = buildPacket(d);
    const cash = pkt.packet.current && pkt.packet.current.spendableHouseholdCash;
    ok(cash && cash.trust !== 'posted', 'spendable household cash is not tagged posted', cash ? String(cash.trust) : 'none');
    ok(cash && (cash.status === 'unavailable'
      || (cash.trust === 'unknown' && cash.trustSource === 'not-tagged-by-Forecast')),
      'spendable household cash reads unknown/not-tagged-by-Forecast',
      cash ? String(cash.trust) + '/' + String(cash.trustSource) : 'none');
    noTagMoreCertainThanBase(pkt.packet, 'bills-only household');
  }

  console.log('\n=== a refresh rejected before any household date reads unavailable in both ===');
  {
    const d = invented();
    d.liveOverlay = { applied: false, operatingPlan: 'dated-opening', reason: 'provider-unavailable' };
    const page = await bootPage(JSON.parse(JSON.stringify(d)));
    const pkt = buildPacket(d);
    const shellRec = page.calls.recommend.find(c => c.origin === 'shell');
    ok(!!shellRec, 'the Stack shell asks Forecast for the plan');
    const pageUnavailable = page.sb.Forecast.liveOperatingPlanUnavailable(shellRec.r, d.liveOverlay);
    ok(pageUnavailable === true, 'the Stack page reads the current plan unavailable (PA-5 #775)');
    ok(shellRec.args[2].operatingPlan === 'unavailable'
      && pkt.calls.recommend[0].args[2].operatingPlan === 'unavailable',
      'the Stack shell and the packet tell Forecast the effective verdict, unavailable');
    // RETIRES AT C1 S7 with the classic page: the classic page's own verdict and input.
    const classicCall = page.calls.recommend.find(c => c.origin === 'classic');
    ok(!!classicCall, 'the classic page asks Forecast for the plan (retires at C1 S7)');
    ok(vm.runInContext('liveOperatingPlanUnavailable', page.sb)(classicCall.r, d.liveOverlay) === true,
      'the classic page reads the current plan unavailable (PA-5 #775) [classic page, retires at S7]');
    ok(classicCall.args[2].operatingPlan === 'unavailable',
      'the classic page tells Forecast the effective verdict, unavailable [classic page, retires at S7]');
    const cash = pkt.packet.current && pkt.packet.current.spendableHouseholdCash;
    ok(cash && cash.status !== 'ok' && cash.current !== true,
      'the packet does not publish the committed opening as current, status ok', cash ? String(cash.status) : 'none');
  }

  console.log('\n=== a withheld settlement outcome publishes no plan on the Stack page and none in the packet (ATLAS-080) ===');
  {
    const d = invented();
    d.settlementEvidenceStatus = { status: 'unavailable', reason: 'invalid-configuration' };
    const page = await bootPage(JSON.parse(JSON.stringify(d)));
    const pkt = buildPacket(d);
    ok(page.errors.length === 0, 'the Stack shell ran without falling back to the classic page');
    ok(!page.calls.recommend || !page.calls.recommend.some(c => c.origin === 'shell'),
      'the Stack shell asks Forecast for no plan');
    const ctx = page.sb.StackBlocks && page.sb.StackBlocks.context && page.sb.StackBlocks.context();
    ok(!!ctx && ctx.recommendation === null, 'the Stack shell hands its blocks no recommendation');
    const f = pkt.packet.forecast;
    ok(f && f.status === 'unavailable' && f.recommendation && f.recommendation.status === 'unavailable',
      'the packet prints the recommendation as unavailable', f ? String(f.status) : 'none');
  }

  console.log(`\n${checks} checks, ${failures} failed`);
  if (failures) process.exit(1);
  console.log('The assistant packet answers the page\'s question.');
})().catch(err => { console.error(err); process.exit(1); });
