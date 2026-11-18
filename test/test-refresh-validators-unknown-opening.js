'use strict';
/* The production write path's opening rule (opening-gate follow-up, part c;
 * lead ruling, option B). Forecast.startingCashAmount is null while the
 * opening gate fails, and `isFinite(null)` is true, so a check written that
 * way would accept any write. The rule, judged by Forecast's opening gate
 * (openingCashState) and never by the numeric seed:
 *   - degrade: a write that takes a complete opening to incomplete is refused;
 *   - stays incomplete: a write that leaves an already-incomplete opening
 *     incomplete applies (a refresh is not frozen while one account is
 *     unknown; publication already withholds the figures);
 *   - completes: a write that completes the opening applies;
 *   - control: complete to complete applies.
 * Checked on canonical-refresh validateApplied and validatePendingApplied,
 * and (stays incomplete, plus a control) on the live-plan overlay.
 * The posted-cash preview's forecast-starting-cash artifact reports
 * "unknown" (no delta) when either side's gate fails, and the incumbent
 * delta when both hold. The acceptance script's independent spendable sum
 * is unknown (null) when a chequing balance is missing, never a sum with 0.
 * Invented documents only.
 *
 * `node test/test-refresh-validators-unknown-opening.js`
 */
const Refresh = require('../scripts/canonical-refresh.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

function doc(breakdown) {
  return {
    meta: { asOf: '2026-10-14' },
    debts: [],
    plan: {
      opening: { asOf: '2026-10-14' },
      startingCash: { breakdown },
      income: [], bills: [], obligations: [], commitments: [], budget: { categories: [] },
    },
  };
}
const A = v => ({ id: 'chequing-a', value: v });
const B = v => ({ id: 'chequing-b', value: v });
const S = v => ({ id: 'savings', value: v });
const refusal = fn => { try { fn(); return null; } catch (e) { return String(e && e.message || e); } };

// Degrades that leave every posted number unchanged, so only the opening
// rule can see them (a removed row is already refused as an unapproved
// locator change): chequing A flagged unknown, or chequing A duplicated.
const COMPLETE = () => doc([A(250), B(300), S(1000)]);
const DEGRADED = [
  ['chequing A flagged unknown', () => doc([{ id: 'chequing-a', value: 250, unknown: true }, B(300), S(1000)])],
  ['chequing A duplicated', () => doc([A(250), A(250), B(300), S(1000)])],
];
const moveA = [{ collection: 'cash', locator: 'cash:chequing-a', field: 'value', currentValue: 250, proposedValue: 240 }];
const withA = (d, v) => { d.plan.startingCash.breakdown.filter(r => r.id === 'chequing-a').forEach(r => { r.value = v; }); return d; };
for (const [label, validate, proposedOk] of [
  ['validateApplied', (b, a, proposed = []) => Refresh.validateApplied(b, a, { proposed }), true],
  ['validatePendingApplied', (b, a) => Refresh.validatePendingApplied(b, a, { openingCutover: { pendingTransitions: [] } }), false],
]) {
  console.log(`\n=== ${label} ===`);
  ok(refusal(() => validate(COMPLETE(), COMPLETE())) === null, 'control: complete to complete applies');
  for (const [name, make] of DEGRADED) {
    const degrade = refusal(() => validate(COMPLETE(), make()));
    ok(degrade && /would leave the opening cash incomplete/.test(degrade), `degrade (${name}): refused`, degrade || 'accepted');
    const stays = refusal(() => validate(make(), make()));
    ok(stays === null, `stays incomplete (${name}): applies, no seed read`, stays || '');
    const completes = refusal(() => validate(make(), COMPLETE()));
    ok(completes === null, `completes (${name}): applies`, completes || '');
  }
  if (proposedOk) {
    const bMissing = () => doc([A(250), S(1000)]);
    const why = refusal(() => validate(bMissing(), withA(bMissing(), 240), moveA));
    ok(why === null, 'stays incomplete (chequing B missing): an approved write to chequing A applies', why || '');
    const why2 = refusal(() => validate(COMPLETE(), withA(COMPLETE(), 240), moveA));
    ok(why2 === null, 'control: the same approved write applies on a complete opening', why2 || '');
  }
}

// Follow-up to #1386 (notes 1-3): the same rule on the opening cutover and
// the payday-observation persist, and on an opening with no breakdown.
const NO_BREAKDOWN = amount => {
  const d = doc([]);
  d.plan.startingCash = amount === undefined ? {} : { amount };
  return d;
};
const cutover = { openingCutover: { requestedAsOf: '2026-10-14',
  proposedOpening: { posted: [], pending: [], representedEvents: [] } } };
const PAYDAY = '2026-10-15';
const paydayProposal = { paydayDate: PAYDAY, packet: { periodStart: PAYDAY, asOf: PAYDAY,
  accounts: [{ id: 'chequing-a', value: 250, evidenceDate: PAYDAY, temporalClaim: 'posted-balance-observed-on-household-date' }] } };
const withPacket = d => { d.plan.opening.paydayAccountObservations = JSON.parse(JSON.stringify(paydayProposal.packet)); return d; };
for (const [label, validate] of [
  ['validateOpeningApplied', (b, a) => Refresh.validateOpeningApplied(b, a, cutover)],
  ['validatePaydayObservationApplied', (b, a) => Refresh.validatePaydayObservationApplied(b, withPacket(a), paydayProposal)],
]) {
  console.log(`\n=== ${label} ===`);
  ok(refusal(() => validate(COMPLETE(), COMPLETE())) === null, 'control: complete to complete applies',
    refusal(() => validate(COMPLETE(), COMPLETE())) || '');
  for (const [name, make] of DEGRADED) {
    const degrade = refusal(() => validate(COMPLETE(), make()));
    ok(degrade && /would leave the opening cash incomplete/.test(degrade), `degrade (${name}): refused`, degrade || 'accepted');
    const stays = refusal(() => validate(make(), make()));
    ok(stays === null, `stays incomplete (${name}): applies, no seed read`, stays || '');
  }
  // No breakdown: a known amount is complete (a known 0 included); a null,
  // missing or non-finite amount is incomplete, never ready at 0.
  for (const [name, amount] of [['null', null], ['missing', undefined], ['not a number', 'x']]) {
    const degrade = refusal(() => validate(NO_BREAKDOWN(250), NO_BREAKDOWN(amount)));
    ok(degrade && /would leave the opening cash incomplete/.test(degrade),
      `no breakdown, a known amount becomes ${name}: refused`, degrade || 'accepted');
    const stays = refusal(() => validate(NO_BREAKDOWN(amount), NO_BREAKDOWN(amount)));
    ok(stays === null, `no breakdown, ${name} amount stays ${name}: applies, no seed read`, stays || '');
  }
  ok(refusal(() => validate(NO_BREAKDOWN(0), NO_BREAKDOWN(0))) === null, 'no breakdown, a known 0 stays complete: applies');
}

console.log('\n=== Forecast: an opening with no breakdown ===');
{
  const Forecast = require('../public/forecast.js');
  for (const [name, cash, ready, amount] of [
    ['no startingCash', undefined, false, null], ['no amount', {}, false, null], ['amount null', { amount: null }, false, null],
    ['amount NaN', { amount: NaN }, false, null], ['amount not a number', { amount: 'x' }, false, null], ['amount blank', { amount: '' }, false, null],
    ['amount 0', { amount: 0 }, true, 0], ['amount "0"', { amount: '0' }, true, 0], ['amount 120', { amount: 120 }, true, 120],
  ]) {
    const plan = cash === undefined ? {} : { startingCash: cash };
    const state = Forecast.openingCashState(plan);
    ok(state.status === (ready ? 'ready' : 'unavailable') && Forecast.startingCashAmount(plan) === amount,
      `${name}: ${ready ? 'ready at ' + amount : 'unknown, never ready at 0'}`, `${state.status} ${Forecast.startingCashAmount(plan)}`);
  }
}

console.log('\n=== live overlay (scripts/live-plan.js) ===');
{
  // The read-only live overlay follows the same rule. A world whose opening is
  // already incomplete still overlays (the strict rule refused it), and
  // publication withholds the figures; a complete world overlays as before.
  const H = require('./acceptance/harness.js');
  const Forecast = require('../public/forecast.js');
  for (const [name, patch] of [
    ['complete opening (control)', null],
    ['chequing B flagged unknown', rows => rows.forEach(r => { if (r.id === 'chequing-b') r.unknown = true; })],
    ['chequing A duplicated', rows => rows.push({ ...rows.find(r => r.id === 'chequing-a') })],
  ]) {
    const w = H.baseWorld('2026-10-14');
    if (patch) w.planPatch = plan => patch(plan.startingCash.breakdown);
    let result;
    try { result = H.dataOf(w); } catch (e) { result = { error: e }; }
    const gate = result.data && Forecast.openingCashState(result.data.plan).status;
    ok(!result.error && result.data.liveOverlay && result.data.liveOverlay.applied === true
      && gate === (patch ? 'unavailable' : 'ready'),
      `${name}: the overlay applies${patch ? ' and the opening stays incomplete (no seed read)' : ''}`,
      result.error ? result.error.message : `gate=${gate}`);
  }
}

console.log('\n=== live overlay: a complete opening made incomplete is refused ===');
{
  // The overlay itself never empties a known chequing row, so the degrade is
  // injected at the last step before the check (the Lunch Money budget
  // derivation on the overlaid plan): chequing A becomes unknown there.
  const H = require('./acceptance/harness.js');
  const Forecast = require('../public/forecast.js');
  const real = Forecast.withLunchMoneyBudgets;
  for (const [name, degrade] of [
    ['chequing A flagged unknown', rows => rows.forEach(r => { if (r.id === 'chequing-a') r.unknown = true; })],
    ['chequing A duplicated', rows => rows.push({ ...rows.find(r => r.id === 'chequing-a') })],
  ]) {
    Forecast.withLunchMoneyBudgets = (...args) => {
      const plan = real(...args); degrade(plan.startingCash.breakdown); return plan;
    };
    const Live = require('../scripts/live-plan');
    const w = H.baseWorld('2026-10-14');
    H.productionOpening(w);
    const plan = H.planOf(w);
    const why = refusal(() => Live.fromObservation({ data: H.canonicalOf(w, plan), payload: H.rawPayload(w),
      accountMap: H.accountMapOf(w), identity: H.identityOf(w) }));
    Forecast.withLunchMoneyBudgets = real;
    ok(why && /would leave the opening cash incomplete/.test(why), `${name}: the overlay is refused`, why || 'accepted');
  }
  Forecast.withLunchMoneyBudgets = real;
}

console.log('\n=== posted-cash preview artifact ===');
{
  const change = (current, proposed) => [{ collection: 'cash', locator: 'cash:chequing-a', field: 'value',
    currentValue: current, proposedValue: proposed }];
  const artifact = (data, proposed) => Refresh.downstreamArtifactsFrom(data, proposed)
    .find(row => row.kind === 'forecast-starting-cash');
  const known = artifact(doc([A(250), B(300)]), change(250, 240));
  ok(known && known.wouldChange === true && Math.abs(known.independentDelta - -10) < 0.005 && known.startingCash === undefined,
    'complete opening: the delta is claimed (250 -> 240 is -10)', JSON.stringify(known));
  const unknown = artifact(doc([A(250), S(1000)]), change(250, 240));
  ok(unknown && unknown.startingCash === 'unknown' && unknown.wouldChange === null && unknown.independentDelta === null,
    'incomplete opening (B missing): starting cash is unknown, no delta claimed', JSON.stringify(unknown));
}

console.log('\n=== acceptance: independent spendable cash ===');
{
  const Loop = require('../scripts/refresh-loop-acceptance.js');
  const plan = rows => ({ startingCash: { breakdown: rows } });
  ok(Loop.independentSpendable(plan([{ id: 'chequing-a', value: 250 }, { id: 'chequing-b', value: 300 },
    { id: 'savings', value: 1000 }])) === 550, 'both chequing balances known: 250 + 300 = 550 (savings excluded)');
  ok(Loop.independentSpendable(plan([{ id: 'chequing-a', value: 250 }, { id: 'savings', value: 1000 }])) === null,
    'chequing B missing: unknown, never 250 (B counted as 0)');
  ok(Loop.independentSpendable(plan([{ id: 'chequing-a', value: 250 }, { id: 'chequing-b', value: null }])) === null,
    'chequing B null: unknown, never 250');
}

console.log(failures ? `\n${failures} FAILED` : '\nAll refresh opening checks passed');
process.exit(failures ? 1 : 0);
