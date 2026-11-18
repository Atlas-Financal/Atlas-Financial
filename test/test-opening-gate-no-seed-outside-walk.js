'use strict';
/* When the opening cash gate fails, nothing outside the cash walk sees a
 * starting cash number (lead ruling, follow-up to #1308's opening gate).
 *
 * The walk still needs a numeric seed to run, and it keeps one privately
 * (postedHouseholdChequingCash). Everything else must not move with it:
 *   - Forecast.startingCashAmount is null (Unknown) while the gate fails;
 *   - no figure recommend, paydayAllocation or simulate publishes
 *     changes when only the value of the present operating account changes;
 *   - a stale saved "next period" Plan selection cannot print a projected
 *     balance as the "Last trusted opening";
 *   - live-plan's paydayOpeningCashKnown agrees with Forecast's gate.
 *
 * Differential proof: under an incomplete opening the present account's
 * value is the only thing varied (1,111.11 vs 2,222.22). Any published number
 * that moves with it was built on the incomplete opening. Chequing A's own
 * observed balance (liveCurrentBalance, its Current Balance publication and
 * the Bills account's observed cash) is excluded: A itself is known.
 *
 * Invented world only (test/acceptance/harness.js).
 * `node test/test-opening-gate-no-seed-outside-walk.js`
 */
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');
const Live = require('../scripts/live-plan.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const AS_OF = '2026-10-14';
const LOW = 1111.11, HIGH = 2222.22;
const SHAPES = {
  'chequing B missing': (a, b, s, v) => [{ ...a, value: v }, ...(s ? [s] : [])],
  'chequing A duplicated': (a, b, s, v) => [{ ...a, value: 100 }, { ...a, value: 100 }, { ...b, value: v }, ...(s ? [s] : [])],
  'Savings only': (a, b, s, v) => [{ ...(s || { id: 'savings' }), value: v }],
};

function world(shape, v) {
  const w = H.baseWorld(AS_OF);
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  if (shape) {
    w.planPatch = plan => {
      const rows = plan.startingCash.breakdown;
      const a = rows.find(r => r.id === 'chequing-a'), b = rows.find(r => r.id === 'chequing-b'), s = rows.find(r => r.id === 'savings');
      plan.startingCash.breakdown = SHAPES[shape](a, b, s, v);
    };
  }
  return w;
}
// The engine cases shape the opening after the observer applied the live
// overlay: the overlay itself refuses an observed account with no opening
// row, so the incomplete breakdown is set on the served plan directly.
function served(shape, v) {
  const { data, packet, error } = H.dataOf(world(null, v));
  if (error) throw error;
  if (shape) {
    const rows = data.plan.startingCash.breakdown;
    const a = rows.find(r => r.id === 'chequing-a'), b = rows.find(r => r.id === 'chequing-b'), s = rows.find(r => r.id === 'savings');
    data.plan.startingCash.breakdown = SHAPES[shape](a, b, s, v);
  }
  return { plan: data.plan, opts: { debts: data.debts, currentPeriodActuals: packet } };
}
function flat(o, p = '', out = {}, seen = new WeakSet()) {
  if (o && typeof o === 'object') {
    if (seen.has(o)) return out;
    seen.add(o);
    for (const [k, v] of Object.entries(o)) flat(v, p ? p + '.' + k : k, out, seen);
  } else if (typeof o === 'number') out[p] = o;
  return out;
}
const OBSERVED_A = /liveCurrentBalance|currentBalancePublication\.amount|billsAccountPeriodBalance\.observedCash/;
function published({ plan, opts }) {
  return {
    recommend: flat(F.recommend(plan, AS_OF, opts)),
    paydayAllocation: flat(F.paydayAllocation(plan, AS_OF, opts)),
    simulate: flat(F.simulate(plan, AS_OF, opts)),
  };
}
function moved(x, y) {
  const out = [];
  for (const part of Object.keys(x)) {
    for (const key of new Set([...Object.keys(x[part]), ...Object.keys(y[part])])) {
      if (x[part][key] !== y[part][key] && !OBSERVED_A.test(key)) out.push(part + ':' + key);
    }
  }
  return out;
}

console.log('\n=== control: a complete opening is a figure, and it moves with the account ===');
{
  const low = served(null, null), plan = low.plan;
  ok(F.openingCashState(plan).status === 'ready', 'the harness opening is complete');
  ok(typeof F.startingCashAmount(plan) === 'number' && F.startingCashAmount(plan) === F.spendableHouseholdCash(plan),
    'startingCashAmount is the published spendable cash when the gate holds', String(F.startingCashAmount(plan)));
  const a = served(null, null), b = served(null, null);
  a.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value = LOW;
  b.plan.startingCash.breakdown.find(r => r.id === 'chequing-a').value = HIGH;
  ok(moved(published(a), published(b)).length > 0, 'positive control: published figures do move with a complete opening');
  ok(Live.paydayOpeningCashKnown(plan) === true, 'live-plan mirror: a complete opening is known');
}

for (const shape of Object.keys(SHAPES)) {
  console.log(`\n=== ${shape} ===`);
  const low = served(shape, LOW), high = served(shape, HIGH);
  ok(F.openingCashState(low.plan).status === 'unavailable', 'the opening gate fails');
  ok(F.startingCashAmount(low.plan) === null && F.startingCashAmount(high.plan) === null,
    'startingCashAmount is null (Unknown), not a seed', `${F.startingCashAmount(low.plan)}`);
  const drift = moved(published(low), published(high));
  ok(drift.length === 0, 'no published figure moves with the incomplete opening', drift.slice(0, 8).join(', '));
  ok(Live.paydayOpeningCashKnown(low.plan) === false, 'live-plan mirror agrees: not known');
}

console.log('\n=== live-plan mirror agrees with the gate on edge shapes ===');
for (const [name, cash, expected] of [
  ['explicit empty breakdown beside an amount', { amount: 500, breakdown: [] }, false],
  ['breakdown of non-operating rows only', { breakdown: [{ id: 'invented-other', value: 500 }] }, false],
  ['aggregate amount only', { amount: 500 }, true],
  ['aggregate with no recorded amount', { amount: null }, false],
]) {
  const plan = { startingCash: cash, opening: { asOf: AS_OF } };
  const gateReady = Object.hasOwn(cash, 'breakdown') ? F.openingCashState(plan).status === 'ready' : null;
  ok(Live.paydayOpeningCashKnown(plan) === expected && (gateReady === null || gateReady === expected),
    `${name}: mirror ${expected ? 'known' : 'not known'}${gateReady === null ? '' : ', same as the gate'}`,
    `mirror=${Live.paydayOpeningCashKnown(plan)} gate=${gateReady}`);
}

function hasBrowser() {
  try { require.resolve('playwright'); return true; } catch { return false; }
}
(async () => {
  if (!hasBrowser() || process.env.ATLAS_SKIP_BROWSER === '1') {
    console.log('\n  SKIP  page case: Playwright Chromium is not available here');
  } else {
    console.log('\n=== page: a stale saved "next period" selection prints no projected opening ===');
    const texts = [], trustedNodes = [];
    for (const v of [LOW, HIGH]) {
      await H.withBudget(world('chequing B missing', v), async p => {
        await p.page.evaluate(() => sessionStorage.setItem('atlas.planSelection.v1', JSON.stringify({ look: 'next-period', periodId: null })));
        await p.reload();
        texts.push(await p.text('body'));
        trustedNodes.push(await p.page.$$eval('[data-last-trusted-opening]', nodes => nodes.length));
      });
    }
    await H.closeBrowser();
    const a = texts[0].split('\n'), b = texts[1].split('\n');
    const differing = a.filter((line, i) => line !== b[i] && !/Latest recorded Bills balance/.test(line));
    ok(differing.length === 0, 'no printed figure moves with the incomplete opening (A\'s own recorded balance aside)',
      differing.slice(0, 4).join(' | '));
    ok(trustedNodes.every(n => n === 0), 'no last-trusted-opening line is printed at all', trustedNodes.join(','));
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll opening-gate checks passed');
  process.exit(failures ? 1 : 0);
})();
