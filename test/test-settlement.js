'use strict';
/* B91 D3 — settlement-aware commitments, opening-relative.
 *
 * Acceptance corpus: docs/source_intake/PAYDAY_ACCEPTANCE_2026-08-14.md
 * Live Fusion camp / tryouts now carry owner-approved settledOn 2026-08-14.
 * This suite still proves the mechanism on synthetic fixtures, and that
 * the reconciler does not write data.json.
 *
 * Independent proof: hand subtraction of named amounts. That is not a
 * second call to expandEvents or simulate.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const F = require('../public/forecast.js');
const R = require('../scripts/reconcile.js');
const live = require('../data.json');
const settlements = require('../docs/reconciliation/commitment-settlements.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const money = n => '$' + Number(n).toFixed(2);
const clone = x => JSON.parse(JSON.stringify(x));
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const SETTLED_ON = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const independentlySettledOn = c =>
  typeof c.settledOn === 'string' && SETTLED_ON.test(c.settledOn) ? c.settledOn : null;
const independentlySettledBy = (c, start) => {
  const d = independentlySettledOn(c);
  return !!(d && typeof start === 'string' && SETTLED_ON.test(start) && d <= start);
};

const START = '2026-08-14';
const END = F.addDays(START, 27);
const OPENING = 2000;
const CAMP = 786;
const SIBLING = 50;
const CAMP_DATE = '2026-08-20';
const PAID_BEFORE_OPENING = '2026-08-10';
const DUE = '2026-08-16';
const PAID = '2026-08-14';
const AUG9 = '2026-08-09';
const AUG15 = '2026-08-15';

function fixture(extraCommitments) {
  return {
    windowDays: 28,
    defaults: { targetBuffer: 0 },
    startingCash: { amount: OPENING },
    income: [],
    obligations: [],
    bills: [],
    budget: {
      basis: 'ytd',
      categories: [{ id: 'sport', class: 'discretionary', from: [] }],
    },
    commitments: extraCommitments || [
      {
        id: 'camp',
        date: CAMP_DATE,
        label: 'Fusion camp (synthetic)',
        amount: CAMP,
        confidence: 'estimated',
        sinkingFund: true,
        budgetCategory: 'sport',
      },
      {
        id: 'sibling',
        date: CAMP_DATE,
        label: 'Same-day sibling',
        amount: SIBLING,
        confidence: 'confirmed',
        sinkingFund: true,
        budgetCategory: 'sport',
      },
    ],
  };
}

function temporalFixture() {
  const plan = fixture();
  plan.commitments[0].date = DUE;
  plan.commitments[0].settledOn = PAID;
  plan.commitments[1].date = DUE;
  return plan;
}

function commitmentCash(plan, start, end) {
  return (plan.commitments || [])
    .filter(c => !independentlySettledBy(c, start) && c.date >= start && c.date <= end)
    .reduce((s, c) => s + Number(c.amount || 0), 0);
}

function windowEnd(start) {
  return F.addDays(start, 27);
}

const PERIODS = { periods: { ytd: { months: 3, label: 'ytd', spending: [] } } };

function sinkingLabels(plan, start) {
  const b = F.budgetBreakdown(plan, PERIODS, { asOf: start });
  return ((b && b.sinkingItems) || []).map(s => s.label);
}

function estimatedRisk(plan, start) {
  const sim = F.simulate(plan, start, { weeklyVariable: 0 });
  const outlook = F.planPhases(plan, {
    weekly: 0,
    sim,
    gap: null,
    funding: { feasible: true, shortfall: 0, parts: [] },
  }, {
    marks: [{ day: 0, date: start, consumer: 0, headroom: 0, debts: [] }],
    crossings: [],
  }, { sim, disabled: [] });
  return (outlook.risks || []).find(r => r.id === 'estimatedCommitments') || null;
}

console.log('=== preserved: unsettled $786 future commitment reserves $786 ===');
{
  const plan = fixture();
  const events = F.expandEvents(plan, START, END, {});
  const camp = events.find(e => e.id === 'camp');
  ok(!!camp && camp.date === CAMP_DATE && near(camp.amount, -CAMP),
    'unsettled camp produces a cash event of −$786', money(camp && camp.amount));
  const independent = commitmentCash(plan, START, END);
  ok(near(independent, CAMP + SIBLING),
    'independent walk reserves camp + sibling', money(independent));
  const sim = F.simulate(plan, START, { weeklyVariable: 0 });
  ok(near(sim.ending, OPENING - independent),
    'unsettled ending is opening minus both commitments', money(sim.ending));
  ok(near(sim.totals.commitments, independent),
    'Forecast commitment total matches the independent walk');
}

console.log('\n=== preserved: settling changes ending cash by exactly +$786 ===');
{
  const unsettled = F.simulate(fixture(), START, { weeklyVariable: 0 });
  const settledPlan = fixture();
  settledPlan.commitments[0].settledOn = PAID_BEFORE_OPENING;
  const settled = F.simulate(settledPlan, START, { weeklyVariable: 0 });
  const delta = Math.round((settled.ending - unsettled.ending) * 100) / 100;
  ok(near(delta, CAMP),
    'settled ending − unsettled ending is +$786', money(delta));
  ok(near(unsettled.ending + CAMP, settled.ending),
    'hand identity: unsettled ending + $786 = settled ending');
}

console.log('\n=== A. Aug. 9 opening still reserves a camp settledOn Aug. 14 ===');
{
  const plan = temporalFixture();
  ok(independentlySettledOn(plan.commitments[0]) === PAID,
    'independent predicate reads the settlement date');
  ok(!independentlySettledBy(plan.commitments[0], AUG9),
    'independent rule: Aug. 14 is after an Aug. 9 opening — still live');
  ok(F.commitmentSettledBy(plan.commitments[0], AUG9) === false,
    'Forecast helper agrees: not settled by Aug. 9');
  const events = F.expandEvents(plan, AUG9, windowEnd(AUG9), {});
  const camp = events.find(e => e.id === 'camp');
  ok(!!camp && camp.date === DUE && near(camp.amount, -CAMP),
    'Aug. 9 Forecast still reserves the Aug. 16 camp at −$786');
  const independent = commitmentCash(plan, AUG9, windowEnd(AUG9));
  ok(near(independent, CAMP + SIBLING),
    'independent walk still reserves camp + sibling', money(independent));
  const sim = F.simulate(plan, AUG9, { weeklyVariable: 0 });
  ok(near(sim.ending, OPENING - independent),
    'Aug. 9 ending still deducts $786', money(sim.ending));
}

console.log('\n=== B. Aug. 14 opening excludes the same settledOn ===');
{
  const plan = temporalFixture();
  ok(independentlySettledBy(plan.commitments[0], START),
    'independent rule: settledOn equals the Aug. 14 opening');
  ok(F.commitmentSettledBy(plan.commitments[0], START) === true,
    'Forecast helper agrees: settled by Aug. 14');
  const events = F.expandEvents(plan, START, END, {});
  ok(!events.some(e => e.id === 'camp'),
    'Aug. 14 Forecast excludes the camp');
  ok(near(commitmentCash(plan, START, END), SIBLING),
    'independent walk now reserves only the sibling');
  const sim = F.simulate(plan, START, { weeklyVariable: 0 });
  ok(near(sim.ending, OPENING - SIBLING),
    'Aug. 14 ending is opening minus the sibling only', money(sim.ending));
}

console.log('\n=== C. Aug. 15 opening also excludes it ===');
{
  const plan = temporalFixture();
  ok(independentlySettledBy(plan.commitments[0], AUG15),
    'independent rule: Aug. 14 is before an Aug. 15 opening');
  ok(F.commitmentSettledBy(plan.commitments[0], AUG15) === true,
    'Forecast helper agrees: settled by Aug. 15');
  const events = F.expandEvents(plan, AUG15, windowEnd(AUG15), {});
  ok(!events.some(e => e.id === 'camp'),
    'Aug. 15 Forecast excludes the camp');
}

console.log('\n=== D. settledOn before opening is still excluded ===');
{
  const plan = fixture();
  plan.commitments[0].settledOn = PAID_BEFORE_OPENING;
  ok(PAID_BEFORE_OPENING < START, 'settledOn is strictly before the opening date');
  ok(CAMP_DATE > START, 'the commitment date is still in the future');
  ok(F.commitmentSettledBy(plan.commitments[0], START) === true,
    'pre-opening settlement is settled for this Forecast');
  const events = F.expandEvents(plan, START, END, {});
  ok(!events.some(e => e.id === 'camp'),
    'a pre-opening settlement still excludes the future-dated camp');

  const misuse = F.expandEvents(fixture(), START, END, {
    representedEvents: [{ id: 'camp', date: CAMP_DATE }],
  });
  ok(misuse.some(e => e.id === 'camp' && near(e.amount, -CAMP)),
    'representedEvents does not hide a future-dated paid commitment');
}

console.log('\n=== E. garbage settledOn stays reserved ===');
{
  const garbage = fixture();
  garbage.commitments[0].settledOn = 'paid';
  ok(!independentlySettledOn(garbage.commitments[0]),
    'independent predicate rejects a non-date settledOn');
  ok(F.commitmentSettledOn(garbage.commitments[0]) === null,
    'garbage has no settled-on date, so it stays unsettled');
  ok(F.commitmentSettledBy(garbage.commitments[0], START) === false,
    'garbage is not settled for the Forecast opening');
  ok(F.expandEvents(garbage, START, END, {}).some(e => e.id === 'camp'),
    'garbage settledOn does not silently drop the cash event');
}

console.log('\n=== F. sibling commitment still fires ===');
{
  const plan = temporalFixture();
  const events = F.expandEvents(plan, START, END, {});
  const sibling = events.find(e => e.id === 'sibling');
  ok(!!sibling && sibling.date === DUE && near(sibling.amount, -SIBLING),
    'sibling on the same date still fires at −$50');
  ok(events.filter(e => e.date === DUE).length === 1,
    'exactly one cash event remains on that date after settlement-day exclusion');

  const before = F.expandEvents(plan, AUG9, windowEnd(AUG9), {});
  ok(before.some(e => e.id === 'sibling' && near(e.amount, -SIBLING)),
    'sibling also fires on the Aug. 9 opening that still reserves the camp');
  ok(before.filter(e => e.date === DUE).length === 2,
    'Aug. 9 keeps both same-day commitments');
}

console.log('\n=== G. sinking-fund and estimated-risk use the same opening rule ===');
{
  const plan = temporalFixture();
  const beforeSinking = sinkingLabels(plan, AUG9);
  const afterSinking = sinkingLabels(plan, START);
  const laterSinking = sinkingLabels(plan, AUG15);
  ok(beforeSinking.includes('Fusion camp (synthetic)'),
    'sinking fund still names the camp before the settlement date');
  ok(!afterSinking.includes('Fusion camp (synthetic)'),
    'sinking fund drops the camp on the settlement date');
  ok(!laterSinking.includes('Fusion camp (synthetic)'),
    'sinking fund stays dropped after the settlement date');
  ok(afterSinking.includes('Same-day sibling') && beforeSinking.includes('Same-day sibling'),
    'sinking fund still names the unsettled sibling on both sides');

  const beforeRisk = estimatedRisk(plan, AUG9);
  const afterRisk = estimatedRisk(plan, START);
  const laterRisk = estimatedRisk(plan, AUG15);
  ok(beforeRisk && beforeRisk.labels.includes('Fusion camp (synthetic)')
    && near(beforeRisk.total, CAMP),
    'estimated-risk still includes the $786 camp before settlement');
  ok(!afterRisk || !afterRisk.labels.includes('Fusion camp (synthetic)'),
    'estimated-risk drops the camp on the settlement date');
  ok(!laterRisk || !laterRisk.labels.includes('Fusion camp (synthetic)'),
    'estimated-risk stays dropped after the settlement date');
  ok(F.commitmentSettledBy(plan.commitments[0], AUG9) === false
    && F.commitmentSettledBy(plan.commitments[0], START) === true
    && F.commitmentSettledBy(plan.commitments[0], AUG15) === true,
    'both consumers follow Forecast.commitmentSettledBy');
}

console.log('\n=== snapshot-equivalent budgetBreakdown follows settlement timing ===');
{
  const plan = fixture();
  plan.commitments = [{
    id: 'camp',
    date: DUE,
    label: 'Fusion camp (synthetic)',
    amount: CAMP,
    confidence: 'estimated',
    sinkingFund: true,
    budgetCategory: 'sport',
    settledOn: PAID,
  }];
  const snapshotOpts = asOf => ({
    paypalPerMonth: 0,
    weeklyCap: 0,
    asOf,
  });
  const before = F.budgetBreakdown(plan, PERIODS, snapshotOpts(AUG9));
  const onDay = F.budgetBreakdown(plan, PERIODS, snapshotOpts(PAID));
  ok((before.sinkingItems || []).some(s => s.label === 'Fusion camp (synthetic)'),
    'A. budgetBreakdown asOf 2026-08-09 still names the camp in sinking');
  ok(!(onDay.sinkingItems || []).some(s => s.label === 'Fusion camp (synthetic)'),
    'B. budgetBreakdown asOf 2026-08-14 excludes the camp from sinking');

  const snapSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'figures-snapshot.js'), 'utf8');
  ok(/F\.budgetBreakdown\(plan, periods, \{[\s\S]*?\basOf\b/.test(snapSrc),
    'C. figures-snapshot.js passes its canonical asOf into budgetBreakdown');

  const meta = { asOf: PAID };
  const snapshotStyle = F.budgetBreakdown(plan, PERIODS, {
    paypalPerMonth: 0,
    weeklyCap: 0,
    asOf: meta.asOf,
  });
  const timeless = F.budgetBreakdown(plan, PERIODS, {
    paypalPerMonth: 0,
    weeklyCap: 0,
  });
  ok(!(snapshotStyle.sinkingItems || []).some(s => s.label === 'Fusion camp (synthetic)'),
    'C. snapshot-style call with meta.asOf 2026-08-14 excludes the camp');
  ok((timeless.sinkingItems || []).some(s => s.label === 'Fusion camp (synthetic)'),
    'C. omitting asOf still counts the camp — the old snapshot defect');
}

console.log('\n=== no-write: evidence that it was paid does not write data.json ===');
{
  const before = hashFile(R.DEFAULT_DATA);
  const liveCamp = live.plan.commitments.find(c => c.id === 'fusioncamp');
  const liveTryouts = live.plan.commitments.find(c => c.id === 'tryouts');
  ok(liveCamp && liveCamp.amount === CAMP && independentlySettledOn(liveCamp) === PAID,
    'live fusioncamp retains the $786 row with settledOn 2026-08-14');
  ok(liveTryouts && liveTryouts.amount === 140 && independentlySettledOn(liveTryouts) === PAID,
    'live tryouts retain the $140 row with settledOn 2026-08-14');

  const result = R.reconcile({
    data: live,
    map: { mappings: [] },
    observations: [],
    settlements,
  });
  const campRow = result.rows.find(r => r.observationId === 'payday-fusioncamp-settled');
  const tryRow = result.rows.find(r => r.observationId === 'payday-tryouts-settled');
  ok(campRow && campRow.status === 'MATCH' && campRow.canonicalSettledOn === PAID,
    'Aug. 14 camp observation vs canonical settledOn is MATCH');
  ok(tryRow && tryRow.status === 'MATCH' && tryRow.canonicalSettledOn === PAID,
    'Aug. 14 tryouts observation vs canonical settledOn is MATCH');

  const out = execFileSync(process.execPath, ['scripts/reconcile.js'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
  });
  const after = hashFile(R.DEFAULT_DATA);
  ok(before === after, 'running the CLI leaves data.json bytes unchanged');
  ok(/does not write data\.json/.test(out),
    'the printed report repeats the no-write contract');
  ok(/payday-fusioncamp-settled/.test(out) && /MATCH/.test(out),
    'the live report names the Fusion camp MATCH');

  const afterLive = JSON.parse(fs.readFileSync(R.DEFAULT_DATA, 'utf8'));
  const afterCamp = afterLive.plan.commitments.find(c => c.id === 'fusioncamp');
  ok(independentlySettledOn(afterCamp) === PAID,
    'reconciler did not strip settledOn from live fusioncamp');

  const liveEvents9 = F.expandEvents(live.plan, AUG9,
    F.addDays(AUG9, (live.plan.windowDays || 91) - 1), {});
  const liveEvents14 = F.expandEvents(live.plan, START,
    F.addDays(START, (live.plan.windowDays || 91) - 1), {});
  ok(liveEvents9.some(e => e.id === 'fusioncamp' && near(e.amount, -CAMP)),
    'an Aug. 9 Forecast still reserves $786 — settlement is opening-relative');
  ok(!liveEvents14.some(e => e.id === 'fusioncamp'),
    'an Aug. 14 Forecast no longer reserves Fusion camp');
}

console.log('\n=== missing or conflicting evidence does not mark a commitment paid ===');
{
  const plan = fixture();
  const missing = R.reconcile({
    data: { plan },
    map: { mappings: [] },
    observations: [],
    settlementObservations: [{
      observationId: 'camp-missing-date',
      fact: 'settlement',
      commitmentId: 'camp',
      settledOn: null,
      canonical: { collection: 'commitments', id: 'camp' },
    }],
  });
  ok(missing.rows[0].status === 'MISSING',
    'an observation with no settledOn date is MISSING');
  ok(!independentlySettledOn(plan.commitments[0]),
    'that MISSING row did not attach settledOn to the commitment');
  ok(F.expandEvents(plan, START, END, {}).some(e => e.id === 'camp'),
    'Forecast still deducts the camp when settlement evidence is missing');

  const conflict = R.reconcile({
    data: { plan },
    map: { mappings: [] },
    observations: [],
    settlementObservations: [
      {
        observationId: 'camp-paid-a',
        fact: 'settlement',
        commitmentId: 'camp',
        settledOn: '2026-08-01',
        canonical: { collection: 'commitments', id: 'camp' },
      },
      {
        observationId: 'camp-paid-b',
        fact: 'settlement',
        commitmentId: 'camp',
        settledOn: '2026-08-10',
        canonical: { collection: 'commitments', id: 'camp' },
      },
    ],
  });
  ok(conflict.rows.every(r => r.status === 'CONFLICT'),
    'two disagreeing settlement dates are CONFLICT');
  ok(!plan.commitments[0].settledOn,
    'CONFLICT does not write a settlement date onto the commitment');
  ok(F.expandEvents(plan, START, END, {}).some(e => e.id === 'camp' && near(e.amount, -CAMP)),
    'Forecast still reserves $786 when settlement evidence conflicts');

  const unknown = R.reconcile({
    data: { plan: fixture() },
    map: { mappings: [] },
    observations: [],
    settlementObservations: [{
      observationId: 'ghost-settled',
      fact: 'settlement',
      commitmentId: 'does-not-exist',
      settledOn: '2026-08-14',
      canonical: { collection: 'commitments', id: 'does-not-exist' },
    }],
  });
  ok(unknown.rows[0].status === 'MISSING',
    'settlement evidence for an unknown commitment id is MISSING');
}

console.log('\n=== live Aug. 14 Fusion write follows commitmentSettledBy ===');
{
  const camp = live.plan.commitments.find(c => c.id === 'fusioncamp');
  const tryouts = live.plan.commitments.find(c => c.id === 'tryouts');
  ok(independentlySettledOn(camp) === PAID && independentlySettledOn(tryouts) === PAID,
    'live canonical carries settledOn 2026-08-14 on both Fusion rows');

  const end9 = F.addDays(AUG9, (live.plan.windowDays || 91) - 1);
  const end14 = F.addDays(START, (live.plan.windowDays || 91) - 1);
  const events9 = F.expandEvents(live.plan, AUG9, end9, {});
  const events14 = F.expandEvents(live.plan, START, end14, {});
  ok(events9.some(e => e.id === 'fusioncamp' && near(e.amount, -CAMP)),
    'an Aug. 9 Forecast still reserves Fusion camp');
  ok(events9.some(e => e.id === 'tryouts' && near(e.amount, -140)),
    'an Aug. 9 Forecast still reserves Fusion tryouts');
  ok(!events14.some(e => e.id === 'fusioncamp'),
    'an Aug. 14 Forecast treats Fusion camp as settled');
  ok(!events14.some(e => e.id === 'tryouts'),
    'an Aug. 14 Forecast treats Fusion tryouts as settled');
  ok(F.commitmentSettledBy(camp, AUG9) === false
    && F.commitmentSettledBy(camp, START) === true,
    'live write follows commitmentSettledBy');
}

console.log('\n=== live Fusion season instalments were stale and are gone ===');
{
  const ids = ['fusion-sep', 'fusion-oct', 'fusion-nov'];
  for (const id of ids) {
    const row = live.plan.commitments.find(c => c.id === id);
    ok(!row, `${id} is not a live plan commitment`);
  }
  ok(!settlements.observations.some(o => ids.includes(o.commitmentId)),
    'the settlement fixture does not observe the three removed $500 instalments');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
