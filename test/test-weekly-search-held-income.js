'use strict';
/* The weekly cap search builds the held Other Income set once per search,
 * and the advice is unchanged (ATLAS LEAD 11, speed-up 3).
 *
 * recommendWeekly (public/forecast.js) now hands its probes one held-income
 * holder, as the payday search does, and `weeklyVariable` joins the
 * probe-only keys the holder ignores when matching. This test holds the
 * change to copies of the same source, compiled here:
 *
 *   1. weeklyVariable reaches neither the event expansion nor the hold set:
 *      at up to eight distinct weekly probes per case on the corpus below
 *      (distinct start, end and weeklyVariable), the probe's own options
 *      with weeklyVariable changed alone (to 0, 5, 1,234, 80,000,
 *      -500, NaN, 1e9 and removed) give a byte-identical expandEvents result
 *      and an identical hold set. Two copies that do read it (one in the hold
 *      set, one in the expansion) are caught by the same comparison;
 *   2. a reference copy with the weekly holder off gives identical advice on
 *      every invented figures input at +0/3/7/14/30 days,
 *      on held-income worlds (test/fixtures/held-other-income-search-world)
 *      and on a 753-transaction harness world; a holder that forgets the hold
 *      set changes the advice on a held world, so the comparison can fail;
 *   3. on equal search work (the same probes, holder on versus off), each
 *      weekly search builds the hold set at most once for each walk start
 *      its probes use (as-of, and on some worlds the pay period's start: the
 *      holder keys its entries by start) with the holder, and more often
 *      than that without it;
 *   4. degraded holders fail check 3: one that never stores, one that keeps
 *      weeklyVariable as a match key, one that stores only every other build,
 *      and one that looks up only every other call.
 *
 * `seq` needs no probe-only entry: it is one object for the whole search, so
 * it matches by identity; check 3 would fail if it did not.
 *
 * Invented data only. `node test/test-weekly-search-held-income.js`
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const Snap = require('../scripts/figures-snapshot.js');
const World = require('./fixtures/held-other-income-search-world');
const H = require('./acceptance/harness.js');

let failures = 0, checks = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? ' — ' + detail : ''}`);
};

const FILE = path.join(__dirname, '..', 'public', 'forecast.js');
const SOURCE = fs.readFileSync(FILE, 'utf8');
const replaceOnce = (text, from, to, label) => {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error('anchor not found exactly once: ' + label);
  return parts.join(to);
};
function compile(text, name) {
  const mod = new Module(FILE, module);
  mod.filename = FILE;
  mod.paths = Module._nodeModulePaths(path.dirname(FILE));
  mod._compile(text, FILE.replace(/\.js$/, '-' + name + '.js'));
  return mod.exports;
}
const P = 'globalThis.__atlasWeeklyProof';
const PASS_HOLDER = 'weeklyVariable: w, seq, heldOtherIncomeReuse: weeklyHeldReuse,';
const COMPUTE = 'const computed = computeHeldOtherIncomeKeys(plan, opts, start, events, txs);';
const STORE = 'if (holder && !computed.fromEvents) holder.entries.push(';
const HIT = 'if (entry.start === start && heldOtherIncomeInputsMatch(entry.opts, given)) return new Set(entry.keys);';
const PROBE_ONLY = "'heldOtherIncomeReuse', 'weeklyVariable']);";
const EXPAND = '  function expandEventsInternal(plan, start, end, opts, debtTrace) {';
const COMPUTE_FN = '  function computeHeldOtherIncomeKeys(plan, opts, start, events, txs) {';
const WEEKLY = '  function recommendWeekly(plan, asOf, opts) {';
const PPC = '  function protectedPlanCheck(plan, asOf, opts) {';

// Counted copy: every recommendWeekly call is one weekly search; inside it,
// protectedPlanCheck calls are its probes and hold-set builds are counted.
function counted(text) {
  text = replaceOnce(text, WEEKLY, WEEKLY.replace('recommendWeekly(', 'recommendWeeklyInner(')
    .replace(/^/, '  function recommendWeekly(...args) {\n'
      + `    ${P}.searches++; ${P}.inWeekly++; const starts = ${P}.starts; ${P}.starts = new Set();\n`
      + `    try { return recommendWeeklyInner(...args); }\n`
      + `    finally { ${P}.inWeekly--; ${P}.walkStarts += ${P}.starts.size; ${P}.starts = starts; }\n  }\n`), 'weekly wrapper');
  text = replaceOnce(text, PPC, PPC + ` if (${P}.inWeekly) ${P}.probes++;`, 'probe counter');
  text = replaceOnce(text, COMPUTE, `if (${P}.inWeekly) { ${P}.builds++; ${P}.starts.add(start); } ` + COMPUTE, 'build counter');
  return text;
}
const SHIPPED = counted(SOURCE);
// Section 1: capture each weekly probe's expansion arguments, and export the
// pieces needed to recompute the expansion and the hold set from them.
const capture = text => replaceOnce(
  replaceOnce(text, EXPAND, EXPAND + ` if (${P}.inWeekly && ${P}.capture && opts && opts.heldOtherIncomeReuse)`
    + ` ${P}.captured.push({ plan, start, end, opts });`, 'capture'),
  '  const Forecast = {', '  const Forecast = { __heldOtherIncomeKeys: heldOtherIncomeKeys, __resolveWalk: resolveDalePayrollWalk,', 'export');

const copies = {
  shipped: compile(capture(SHIPPED), 'shipped'),
  reference: compile(replaceOnce(SHIPPED, PASS_HOLDER, 'weeklyVariable: w, seq,', 'holder off'), 'reference'),
  forgetful: compile(replaceOnce(SHIPPED, HIT, HIT.replace('return new Set(entry.keys);', 'return new Set();'), 'forgetful'), 'forgetful'),
  // Section 1 teeth: copies that DO read weeklyVariable.
  readsInHold: compile(capture(replaceOnce(SHIPPED, COMPUTE_FN,
    COMPUTE_FN + ' if (Number(opts && opts.weeklyVariable) > 1000) return { keys: new Set(), fromEvents: false };', 'hold reads')), 'reads-hold'),
  readsInExpand: compile(capture(replaceOnce(SHIPPED, EXPAND,
    EXPAND + ' if (opts && Number(opts.weeklyVariable) > 1000) end = addDays(end, -1);', 'expand reads')), 'reads-expand'),
  // Section 4: degraded holders.
  neverStores: compile(replaceOnce(SHIPPED, STORE, 'if (false) holder.entries.push(', 'never stores'), 'never-stores'),
  weeklyIsKey: compile(replaceOnce(SHIPPED, PROBE_ONLY, "'heldOtherIncomeReuse']);", 'weekly key'), 'weekly-key'),
  storesHalf: compile(replaceOnce(SHIPPED, STORE, `if (holder && !computed.fromEvents && (${P}.tick++ % 2)) holder.entries.push(`, 'stores half'), 'stores-half'),
  looksHalf: compile(replaceOnce(SHIPPED, HIT, `if (entry.start === start && (${P}.tick++ % 2) && heldOtherIncomeInputsMatch(entry.opts, given)) return new Set(entry.keys);`, 'looks half'), 'looks-half'),
};
ok(new Set(Object.values(copies)).size === Object.keys(copies).length, `${Object.keys(copies).length} independent engine copies`);

const reset = (captureOn = false) => {
  globalThis.__atlasWeeklyProof = { searches: 0, probes: 0, builds: 0, walkStarts: 0, starts: new Set(), inWeekly: 0, tick: 0, capture: captureOn, captured: [] };
  return globalThis.__atlasWeeklyProof;
};

// The corpus: each case returns the recommend arguments, freshly cloned.
// The corpus size is derived from the input directory itself (read apart from
// the loader), so a loader that dropped an input, or a corpus below its 13 inputs, fails here.
const SHIFTS = [0, 3, 7, 14, 30];
const INVENTED_INPUTS = fs.readdirSync(path.join(__dirname, 'fixtures', 'figures-inputs')).filter(f => f.endsWith('.json')).length;
const INVENTED_EVALUATIONS = INVENTED_INPUTS * SHIFTS.length;
const cases = [];
for (const input of Snap.loadInventedInputs()) {
  for (const shift of SHIFTS) {
    cases.push({ id: `${input.id} +${shift}`, kind: 'invented', args: F => {
      const data = structuredClone(input.doc.data);
      return [data.plan, F.addDays(data.meta.asOf, shift),
        Snap.pageOptions(data, input.doc.periods == null ? null : structuredClone(input.doc.periods))];
    } });
  }
}
const HELD_AS_OF = '2026-11-10';
for (const [label, world] of [
  ['held world, 120 purchases', { transactions: 120, days: 30, rebate: { date: '2026-11-12', amount: 200 },
    receipts: [{ id: 'gift', date: '2026-11-08', amount: 50 }] }],
  ['held world with the payroll walk', { walk: true, transactions: 120, days: 30, rebate: { date: '2026-11-12', amount: 200 },
    receipts: [{ id: 'gift', date: '2026-11-08', amount: 50 }] }],
]) {
  const data = World.build(Object.assign({ asOf: HELD_AS_OF }, world));
  cases.push({ id: label, kind: 'held', args: () => {
    const d = structuredClone(data);
    return [d.plan, HELD_AS_OF, World.recommendOptions(d)];
  } });
}
{
  // The harness world with 753 invented purchases (567 fall on or before as-of).
  const w = H.baseWorld();
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  for (let i = 0; i < 753; i++) {
    const d = H.lm({ date: '2026-' + (i % 2 ? '10' : '09') + '-' + String(1 + (i % 28)).padStart(2, '0'),
      amount: 5 + (i % 37), category: i % 3 ? 'Groceries' : 'Restaurants', account: 'chequing-a', payee: 'Invented merchant ' + (i % 50) });
    if (d.date <= w.asOf) w.transactions.push(d);
  }
  const { data, packet, error } = H.dataOf(w);
  if (error) throw error;
  cases.push({ id: `harness world, ${w.transactions.length - 1} purchases`, kind: 'large', args: () => {
    const d = structuredClone(data);
    return [d.plan, w.asOf, { debts: d.debts, currentPeriodActuals: structuredClone(packet) }];
  } });
}

function run(F, c, captureOn = false) {
  const proof = reset(captureOn);
  let json;
  try { json = JSON.stringify(F.recommend(...c.args(F))); } catch (err) { json = 'error: ' + (err && err.message); }
  return { json, searches: proof.searches, probes: proof.probes, builds: proof.builds, walkStarts: proof.walkStarts, captured: proof.captured };
}

console.log('1. weeklyVariable reaches neither the expansion nor the hold set');
const VARIANTS = [0, 5, 1234, 80000, -500, NaN, 1e9, undefined];
function isolation(F, c) {
  const { captured } = run(F, c, true);
  let compared = 0, differ = 0, nonEmpty = 0;
  // Every captured probe is compared; a search's probes repeat their start
  // and end, so the first eight distinct ones per case are enough to vary.
  const seen = new Set();
  for (const call of captured) {
    const key = call.start + '|' + call.end + '|' + call.opts.weeklyVariable;
    if (seen.has(key) || seen.size >= 8) continue;
    seen.add(key);
    const strip = o => { const x = Object.assign({}, o); delete x.heldOtherIncomeReuse; return x; };
    const hold = o => { const r = F.__resolveWalk(o);
      return [...F.__heldOtherIncomeKeys(call.plan, r, call.start, [], o)].sort().join(','); };
    const base = strip(call.opts);
    const baseEvents = JSON.stringify(F.expandEvents(call.plan, call.start, call.end, base));
    const baseHold = hold(base);
    if (baseHold) nonEmpty++;
    for (const v of VARIANTS) {
      const varied = Object.assign({}, base);
      if (v === undefined) delete varied.weeklyVariable; else varied.weeklyVariable = v;
      compared++;
      if (JSON.stringify(F.expandEvents(call.plan, call.start, call.end, varied)) !== baseEvents || hold(varied) !== baseHold) differ++;
    }
  }
  return { probes: captured.length, varied: seen.size, compared, differ, nonEmpty };
}
{
  let probes = 0, varied = 0, compared = 0, differ = 0, nonEmpty = 0;
  for (const c of cases) {
    const r = isolation(copies.shipped, c);
    probes += r.probes; varied += r.varied; compared += r.compared; differ += r.differ; nonEmpty += r.nonEmpty;
  }
  ok(varied > 200 && compared === varied * VARIANTS.length && differ === 0,
    `${compared} single-key variations at ${varied} distinct weekly probes (of ${probes} captured): expansion and hold set identical`,
    `${differ} differ`);
  ok(nonEmpty > 0, 'some varied probes carry a non-empty hold set (an expectation held To confirm)', String(nonEmpty));
  const held = cases.filter(c => c.kind === 'held');
  for (const [name, label] of [['readsInHold', 'a hold set that reads weeklyVariable'], ['readsInExpand', 'an expansion that reads weeklyVariable']]) {
    const caught = held.reduce((n, c) => n + isolation(copies[name], c).differ, 0)
      + cases.filter(c => c.kind === 'invented').slice(0, 5).reduce((n, c) => n + isolation(copies[name], c).differ, 0);
    ok(caught > 0, `teeth: ${label} is caught`, `${caught} variations differ`);
  }
}

console.log('2. Identical advice with the weekly holder off and on');
const results = new Map();
{
  let same = 0;
  for (const c of cases) {
    const on = run(copies.shipped, c), off = run(copies.reference, c);
    results.set(c.id, { on, off });
    if (on.json === off.json && !on.json.startsWith('error')) same++;
    else ok(false, `${c.id}: advice identical`);
  }
  const invented = cases.filter(c => c.kind === 'invented').length;
  ok(invented === INVENTED_EVALUATIONS && INVENTED_INPUTS >= 13 && same === cases.length,
    `advice identical on all ${cases.length} cases (${INVENTED_EVALUATIONS} invented evaluations, 2 held worlds, the 753-transaction world)`, `${same} of ${cases.length}`);
  let differs = 0;
  for (const c of cases.filter(x => x.kind === 'held')) if (run(copies.forgetful, c).json !== results.get(c.id).off.json) differs++;
  ok(differs > 0, 'teeth: a holder that forgets the hold set changes the advice on a held world', `${differs} of 2`);
}

console.log('3. At most one hold-set build per weekly search, on equal search work');
const tally = pick => {
  const t = { searches: 0, probes: 0, builds: 0, walkStarts: 0, worst: 0 };
  for (const c of cases) {
    const r = pick(c);
    t.searches += r.searches; t.probes += r.probes; t.builds += r.builds; t.walkStarts += r.walkStarts;
    if (r.walkStarts) t.worst = Math.max(t.worst, r.builds / r.walkStarts);
  }
  return t;
};
// The holder keys its entries by the walk's start date: a search whose
// probes walk from two starts (as-of and the pay period's start) needs one
// hold set for each. "At most once" is per search and walk start.
const within = t => t.searches > 0 && t.builds <= t.walkStarts && t.worst <= 1;
{
  const on = tally(c => results.get(c.id).on), off = tally(c => results.get(c.id).off);
  ok(on.searches === off.searches && on.probes === off.probes && on.searches > 80,
    'equal search work: the same searches and probes with the holder off and on', `${off.searches}/${off.probes} vs ${on.searches}/${on.probes}`);
  ok(within(on) && on.walkStarts <= 2 * on.searches,
    `with the holder: ${on.builds} builds over ${on.searches} weekly searches (${on.walkStarts} search walk starts), at most one per search and start`,
    `worst ${on.worst}`);
  ok(off.builds > 2 * off.walkStarts, `without it: ${off.builds} builds over the same searches and starts`);
  const large = cases.find(c => c.kind === 'large');
  const l = results.get(large.id);
  ok(l.on.builds <= l.on.walkStarts && l.off.builds > 4 * l.off.walkStarts,
    `the 753-transaction world: ${l.off.builds} -> ${l.on.builds} builds over ${l.on.searches} search (${l.on.walkStarts} walk starts)`);
}

console.log('4. Degraded holders fail check 3');
for (const [name, label] of [['neverStores', 'a holder that never stores'], ['weeklyIsKey', 'weeklyVariable kept as a match key'],
  ['storesHalf', 'a holder that stores only every other build'], ['looksHalf', 'a holder that looks up only every other call']]) {
  const t = tally(c => run(copies[name], c));
  ok(!within(t), `${label} is caught`, `${t.builds} builds over ${t.walkStarts} search walk starts`);
}

delete globalThis.__atlasWeeklyProof;
console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} weekly-search held-income checks passed`);
process.exit(failures ? 1 : 0);
