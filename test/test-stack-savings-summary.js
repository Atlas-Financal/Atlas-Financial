'use strict';
/* Stack Wallet A5: each pay period publishes stackSummary.savings (owner-
 * approved design, Dale 2026-11-19; lead rulings).
 *
 * The one authority is savingsFunding (savingsDailyFunding): the current
 * period's goal rows and each later period's projected rows, keyed by goal.
 *   item.needed   the row's thisPeriod (null when unpublished, never 0); for
 *                 the current period it is net of the period's transfers so
 *                 far (reason net-of-period-transfers);
 *   item.saved    always null: nothing attributes ledger movement to a goal,
 *                 and a plan instruction is never proof money moved;
 *   totals        needed = cent sum of every goal's needed, or null; saved =
 *                 the pool's ledger-evidenced period transfers and
 *                 entitlement = the period's savings entitlement, current
 *                 period only, completeness 'pool-level'.
 *
 *   1. hand-derived invented worlds (figures inputs savings-live-ready and
 *      savings-live-partial: the same plan, entitlement 80, the second with a
 *      30 transfer already made): current club still to set aside 80 vs 50 =
 *      80 − 30, saved 0 vs 30 moved of 80; next and future periods gross,
 *      nothing moved, 'future-period'; past periods all null;
 *   2. every period of the invented figures evaluations (and the harness item
 *      world): each item is its savingsFunding row copied, saved null, the
 *      totals rules, pool-level only on the current period, closed reasons,
 *      no status field and no funded wording;
 *   3. every existing field is byte-equal without the new key;
 *   4. mutants are caught: saved from the pool backing (the savings-pot
 *      rule), needed from the goal's whole cost, a partial needed total, a
 *      moved total on a future period, a missing entitlement, the net reason
 *      dropped.
 *
 * Invented data only. `node test/test-stack-savings-summary.js` */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const H = require('./acceptance/harness.js');
const Snap = require('../scripts/figures-snapshot.js');

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
const NEEDED = "      const needed = ready && isSavingsFigure(row.thisPeriod) && Object.hasOwn(STACK_TRUST_RANK, row.thisPeriodTrust)\n        ? row.thisPeriod : null;";
const copies = {
  shipped: require('../public/forecast.js'),
  without: compile(replaceOnce(SOURCE, ', savings: stackSavings(view, result) }', ' }', 'pass off'), 'without'),
  savedFromBacking: compile(replaceOnce(SOURCE, '        saved: null, needed, trust:', '        saved: isSavingsFigure(row.saved) ? row.saved : null, needed, trust:', 'saved from backing'), 'saved-from-backing'),
  neededFromCost: compile(replaceOnce(SOURCE, NEEDED, NEEDED.split('row.thisPeriod').join('row.needed'), 'needed from cost'), 'needed-from-cost'),
  partialNeeded: compile(replaceOnce(SOURCE, '    const neededTotal = items.length && !excluded.length', '    const neededTotal = items.length', 'partial needed'), 'partial-needed'),
  futureMoved: compile(replaceOnce(SOURCE, '    const transferKnown = current && period.status', '    const transferKnown = !!period && period.status', 'future moved'), 'future-moved'),
  noEntitlement: compile(replaceOnce(SOURCE, '        entitlement: entitlementKnown ? period.entitlement : null,', '        entitlement: null,', 'no entitlement'), 'no-entitlement'),
  noNetReason: compile(replaceOnce(SOURCE, "          : current ? [savedReason, 'net-of-period-transfers'] : [savedReason] };", '          : [savedReason] };', 'no net reason'), 'no-net-reason'),
};

const INPUTS = Snap.loadInventedInputs();
const input = id => INPUTS.find(x => x.id === id);
function run(F, inp, shift = 0) {
  const data = structuredClone(inp.doc.data);
  return F.recommend(data.plan, F.addDays(data.meta.asOf, shift),
    Snap.pageOptions(data, inp.doc.periods == null ? null : structuredClone(inp.doc.periods)));
}
const byRole = (r, role) => r.payPeriodViews.filter(v => v.timelineRole === role);
const sav = v => v && v.stackSummary && v.stackSummary.savings;
const item = (s, id) => s && s.items.find(x => x.id === id);

console.log('1. Hand-derived invented worlds');
{
  const ready = run(copies.shipped, input('savings-live-ready'));
  const partial = run(copies.shipped, input('savings-live-partial'));
  const r0 = sav(byRole(ready, 'current')[0]), p0 = sav(byRole(partial, 'current')[0]);
  ok(item(r0, 'group:club').needed === 80 && r0.totals.saved === 0 && r0.totals.entitlement === 80 && r0.totals.completeness === 'pool-level',
    'no transfer yet: club still to set aside 80; 0 moved of 80 this period', JSON.stringify(r0.totals));
  ok(item(p0, 'group:club').needed === 50 && p0.totals.saved === 30 && p0.totals.entitlement === 80 && p0.totals.completeness === 'pool-level',
    'a 30 transfer: club still to set aside 50 = 80 − 30; 30 moved of 80', JSON.stringify(p0.totals));
  ok(item(p0, 'group:club').needed === item(r0, 'group:club').needed - p0.totals.saved,
    'still to set aside falls by exactly what moved (net of the period\'s transfers)');
  ok(p0.items.every(x => x.saved === null && x.reasons.includes('no-per-goal-attribution') && x.reasons.includes('net-of-period-transfers'))
    && p0.totals.reasons.includes('pool-level') && p0.totals.reasons.includes('net-of-period-transfers'),
    'the current period names its saved null as unattributed and its needed as net', JSON.stringify(p0.items));
  ok(p0.totals.needed === 50 && p0.totals.excluded.length === 0, 'totals.needed is every goal\'s still-to-set-aside, summed (50 + 0)');
  const next = sav(byRole(partial, 'next')[0]);
  ok(next && next.items.length > 0 && next.items.every(x => x.saved === null && x.reasons.join() === 'future-period')
    && next.totals.saved === null && next.totals.entitlement === null && next.totals.completeness === 'none',
    'the next period: gross plan, nothing moved, future-period', JSON.stringify(next && next.totals));
  const past = sav(byRole(partial, 'past').at(-1));
  ok(past && past.items.every(x => x.needed === null && x.saved === null && x.trust === 'unavailable' && x.reasons.includes('past-period'))
    && past.totals.needed === null && past.totals.saved === null, 'a past period publishes no savings figure', JSON.stringify(past && past.totals));
  const none = sav(byRole(run(copies.shipped, input('card-paid-clear')), 'current')[0]);
  ok(none && none.items.length === 0 && none.totals.needed === null && none.totals.reasons.includes('planned-unavailable'),
    'a household with no savings goals publishes no figure, with a reason', JSON.stringify(none && none.totals));
}

console.log('2. Every period of the corpus');
const corpus = [];
for (const inp of INPUTS) for (const shift of [0, 3, 7, 14]) corpus.push(F => run(F, inp, shift));
{
  const w = H.baseWorld();
  w.commitments = [{ id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: 'confirmed', sinkingFund: true }];
  w.savingsPool = { value: 1000 };
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  const { data, packet, error } = H.dataOf(w);
  if (error) throw error;
  corpus.push(F => F.recommend(structuredClone(data.plan), w.asOf, { debts: structuredClone(data.debts), currentPeriodActuals: structuredClone(packet) }));
}
const REASONS = new Set(['no-per-goal-attribution', 'net-of-period-transfers', 'future-period', 'past-period',
  'planned-unavailable', 'planned-incomplete', 'pool-level', 'pool-transfer-unavailable']);
function audit(F) {
  const r = { periods: 0, items: 0, published: 0, poolLevel: 0, copyFail: 0, savedFail: 0, totalFail: 0, poolFail: 0, reasonFail: 0, wordingFail: 0, netFail: 0 };
  for (const args of corpus) {
    const res = args(F);
    const funding = res.savingsFunding;
    for (const v of res.payPeriodViews || []) {
      r.periods++;
      const s = sav(v);
      if (!s) { r.copyFail++; continue; }
      const json = JSON.stringify(s);
      if (/funded|"status"/i.test(json)) r.wordingFail++;
      const current = v.timelineRole === 'current' && funding && funding.period && funding.period.start === v.start;
      const pv = funding && Array.isArray(funding.periodViews) ? funding.periodViews.find(p => p.start === v.start) : null;
      const rows = current ? funding.rows || [] : (pv && pv.packet && pv.packet.rows) || [];
      if (rows.length !== s.items.length) r.copyFail++;
      s.items.forEach((x, i) => {
        r.items++;
        const row = rows[i] || {};
        if (x.id !== row.key) r.copyFail++;
        if (x.needed !== null) { r.published++; if (x.needed !== row.thisPeriod || x.trust !== row.thisPeriodTrust) r.copyFail++; }
        if (x.saved !== null) r.savedFail++;
        if (!x.reasons.every(c => REASONS.has(c))) r.reasonFail++;
        if (current && x.needed !== null && !x.reasons.includes('net-of-period-transfers')) r.netFail++;
        if (!current && x.reasons.includes('net-of-period-transfers')) r.netFail++;
      });
      const missing = s.items.filter(x => x.needed === null).map(x => x.id);
      const sum = s.items.length && !missing.length ? s.items.reduce((c, x) => c + Math.round(x.needed * 100), 0) / 100 : null;
      if (s.totals.needed !== sum || JSON.stringify(s.totals.excluded) !== JSON.stringify(missing)) r.totalFail++;
      if (s.totals.completeness === 'pool-level') {
        r.poolLevel++;
        if (!current || s.totals.saved !== funding.period.transferred || s.totals.entitlement !== funding.period.entitlement) r.poolFail++;
      } else if (s.totals.saved !== null || s.totals.entitlement !== null) r.poolFail++;
      if (!s.totals.reasons.every(c => REASONS.has(c))) r.reasonFail++;
    }
  }
  return r;
}
const a = audit(copies.shipped);
ok(a.periods > 100 && a.published > 20 && a.poolLevel >= 5 && a.copyFail === 0,
  `every goal row is its savingsFunding row copied (${a.items} goals, ${a.published} published, ${a.periods} periods)`, JSON.stringify(a));
ok(a.savedFail === 0, 'no goal ever publishes a saved figure', String(a.savedFail));
ok(a.totalFail === 0, 'totals.needed is the cent sum of every goal\'s needed, or null with the missing goals excluded', String(a.totalFail));
ok(a.poolFail === 0, `the pool-level moved and entitlement figures appear only on the current period, as published (${a.poolLevel} periods)`, String(a.poolFail));
ok(a.netFail === 0, 'every current-period needed is marked net of the period\'s transfers, and no later one is', String(a.netFail));
ok(a.reasonFail === 0 && a.wordingFail === 0, 'reasons are from the closed set; no status field and no funded wording', JSON.stringify([a.reasonFail, a.wordingFail]));

console.log('3. Every existing field is byte-equal');
{
  const strip = res => { for (const v of res.payPeriodViews || []) if (v.stackSummary) delete v.stackSummary.savings; return JSON.stringify(res); };
  let same = 0;
  for (const args of corpus) if (strip(args(copies.shipped)) === JSON.stringify(args(copies.without))) same++;
  ok(same === corpus.length, `the advice without stackSummary.savings is byte-equal on all ${corpus.length} cases`, `${same} of ${corpus.length}`);
}

console.log('4. Mutants are caught');
{
  const partial = F => sav(byRole(run(F, input('savings-live-partial')), 'current')[0]);
  ok(audit(copies.savedFromBacking).savedFail > 0, 'saved read from the pool backing (a stock, not a movement) is caught');
  ok(item(partial(copies.neededFromCost), 'group:club').needed !== 50 && audit(copies.neededFromCost).copyFail > 0,
    'needed read from the goal\'s whole cost instead of this period\'s plan is caught');
  ok(audit(copies.partialNeeded).totalFail > 0, 'a partial needed total passed off as a total is caught');
  ok(audit(copies.futureMoved).poolFail > 0, 'a moved total on a non-current period is caught');
  ok(partial(copies.noEntitlement).totals.entitlement === null && partial(copies.shipped).totals.entitlement === 80, 'a missing entitlement is caught');
  ok(audit(copies.noNetReason).netFail > 0, 'a current-period needed not marked net is caught');
}

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} stack savings checks passed`);
process.exit(failures ? 1 : 0);
