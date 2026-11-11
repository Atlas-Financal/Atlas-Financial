'use strict';
/* Focused proof for Forecast.planStatus() and the funding-source verdicts that
 * Forecast.recommend() now returns. `node test/test-status-band.js`
 *
 * These are the two most prominent financial verdicts on the site: the band at
 * the top of the Plan page, which selects which of eight conclusions the
 * household reads about the next 13 weeks, and the cards a few lines below it,
 * which say whether each account can cover the opening gap. Until this move
 * `public/plan.js` decided both, where no test could reach them — B73 recorded
 * ten mutations to those expressions that left `npm test` green.
 *
 * Four kinds of check, and they prove different things:
 *
 *   1. HAND-COMPUTED CASES. The engine is handed literal facts — a $5,543.16
 *      gap against $2,691.85 and $1,067.84 of usable funding, a $1,500/week
 *      setting that runs to −$809.12 — and the expected verdict and every
 *      figure in it are reasoned from those facts in the comment above each
 *      case. Nothing here re-runs the selection to find out what it should be.
 *   2. RECONCILIATION. The funding figures have to add up: every allocated part
 *      plus the shortfall equals the gap, and borrowed plus free equals the
 *      allocation. An identity is checked, not a re-implementation.
 *   3. MUTATION. The verdict ordering, the buffer threshold, the first-breach
 *      selection, the coverage comparison and the shortfall arithmetic are each
 *      broken on purpose in the engine source, and the answer has to change. A
 *      decision that cannot be broken was not being tested.
 *   4. MIGRATION EQUIVALENCE. The exact expressions `public/plan.js` ran before
 *      this move, against the real published plan at ten settings, must still
 *      produce the same band and the same cards — through the page's own
 *      wording maps and the real formatters, not through a copy of them. The
 *      authority moves; the household reads the same words.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sourceText } = require('./test-source-text');
const F = require('../public/forecast.js');
const data = require('../data.json');
const { openingFloor, gapAtBuffer, fundingById, usableFunding } = require('./test-helpers');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const read = p => sourceText(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
// Money compared at the cent, which is the unit every one of these figures is
// published in. A float landing on 3543.1600000000003 is the same $3,543.16.
const cents = n => Math.round(n * 100);
const same = (a, b) => cents(a) === cents(b);

/* ------------------------------------------------------------- fixtures */
/* Literal inputs. `advice` is the shape Forecast.recommend returns; only the
 * fields planStatus reads are given, and every one of them is stated here
 * rather than derived. `daily` is a hand-written balance series — the days the
 * band's two dates are selected from. */
const AS_OF = '2026-08-10';
const day = (date, balance) => ({ date, balance });

const sim = o => Object.assign({
  min: { date: AS_OF, balance: 1200 },
  buffer: 500, ending: 4200, end: '2026-11-07', daily: [day(AS_OF, 1200)],
}, o);

const advice = o => Object.assign({
  weekly: 1250, effectiveFrom: '2026-08-14', gap: null, funding: null, sim: sim(),
}, o);

const GAP_DATE = '2026-08-12';
const gapOf = amount => ({ amount, date: GAP_DATE, floorDate: GAP_DATE,
  dueOnGapDay: 623, preIncomeOut: 623, floor: -543.16 });

// The two usable sources the published plan declares, and what they hold.
const AMANDA = 2691.85, HELOC = 1067.84;

console.log('=== 1. an opening gap no source can reach ===');
/* Hand-computed. At a $5,000 buffer the household is $5,543.16 short at the
 * floor. Amanda's account holds $2,691.85 and the HELOC has $1,067.84 of room:
 * $3,759.69 between them, so $1,783.47 of the gap cannot be funded at all.
 *
 *   allocated  2691.85 + 1067.84 = 3759.69
 *   shortfall  5543.16 − 3759.69 = 1783.47
 *
 * That verdict outranks everything else the window could say, because at that
 * buffer the floor stays below it whatever the household spends. */
const UNFUNDABLE = advice({
  gap: gapOf(5543.16),
  funding: { parts: [{ id: 'amanda', short: "Amanda's transfer", amount: AMANDA, debtId: null },
    { id: 'heloc', short: 'a HELOC draw', amount: HELOC, debtId: 'heloc' }],
  allocated: 3759.69, shortfall: 1783.47, feasible: false, needsCombination: true,
  borrowed: HELOC, free: AMANDA },
  sim: sim({ buffer: 5000, min: { date: GAP_DATE, balance: -543.16 } }),
});
const unfunded = F.planStatus(UNFUNDABLE, { weeklyOverride: null });
ok(unfunded.id === 'unfunded', 'an unfundable opening gap selects the unfunded verdict', unfunded.id);
ok(same(unfunded.gapAmount, 5543.16), 'and states the whole gap', String(unfunded.gapAmount));
ok(same(unfunded.allocated, 3759.69), 'the funding every usable source reaches', String(unfunded.allocated));
ok(same(unfunded.shortfall, 1783.47), 'and what is left unfunded', String(unfunded.shortfall));
ok(same(unfunded.allocated + unfunded.shortfall, unfunded.gapAmount),
  'available funding + shortfall reconciles to the gap',
  `${unfunded.allocated} + ${unfunded.shortfall} = ${unfunded.gapAmount}`);
ok(unfunded.floorDate === GAP_DATE && same(unfunded.buffer, 5000),
  'against the floor date and the buffer in force');

// The ordering claim, proved rather than asserted: an unfundable gap outranks a
// weekly setting that also breaches, because no weekly setting fixes it.
const unfundedWithOverride = F.planStatus(UNFUNDABLE,
  { weeklyOverride: 1500, sim: sim({ buffer: 5000, min: { date: '2026-09-10', balance: -809.12 } }) });
ok(unfundedWithOverride.id === 'unfunded',
  'an unfundable gap outranks a breaching weekly override', unfundedWithOverride.id);

console.log('\n=== 2. a weekly setting the forecast does not support ===');
/* Hand-computed. The gap is $1,043.16 and Amanda covers it alone, so funding is
 * not the problem. The household has set $1,500/week against a supported
 * $1,250, and the run reaches −$809.12 on 10 September.
 *
 * The first breach is measured FROM THE FUNDING DATE, 12 August: the two short
 * days before it are the acknowledged squeeze the funding fixes, not a
 * consequence of the spending setting being judged. 12 August sits exactly ON
 * the $500 buffer, which is not below it. 20 August is above. 27 August at
 * $431.09 is the first day genuinely below, so that is the date. */
const BREACH_DAILY = [
  day('2026-08-10', 79.84),      // before the funding date — ignored
  day('2026-08-11', -543.16),    // before the funding date — ignored
  day('2026-08-12', 500.00),     // exactly on the buffer — not below it
  day('2026-08-20', 612.30),
  day('2026-08-27', 431.09),     // the first real breach
  day('2026-09-03', 120.55),
  day('2026-09-10', -809.12),    // the low
];
const BREACHING_SIM = sim({ buffer: 500, daily: BREACH_DAILY,
  min: { date: '2026-09-10', balance: -809.12 } });
const FUNDABLE = advice({
  gap: gapOf(1043.16),
  funding: { parts: [{ id: 'amanda', short: "Amanda's transfer", amount: 1043.16, debtId: null }],
    allocated: 1043.16, shortfall: 0, feasible: true, needsCombination: false,
    borrowed: 0, free: 1043.16 },
});
const breach = F.planStatus(FUNDABLE, { weeklyOverride: 1500, sim: BREACHING_SIM });
ok(breach.id === 'overrideBreach',
  'a weekly override that breaches the buffer selects the override verdict', breach.id);
ok(breach.firstBelowBuffer === '2026-08-27',
  'and returns the first breach on or after the funding date', String(breach.firstBelowBuffer));
ok(breach.weekly === 1500 && breach.recommended === 1250,
  'naming the figure set and the figure supported');
ok(breach.goesNegative === true && same(breach.low, -809.12) && breach.lowDate === '2026-09-10',
  'and the low the setting reaches');
ok(same(breach.gapAmount, 1043.16), 'the gap is still stated, covered');

/* The same run without the household setting a figure at all is not a breach —
 * the recommended cap is what the engine solved for. */
const noOverride = F.planStatus(FUNDABLE, { weeklyOverride: null, sim: BREACHING_SIM });
ok(noOverride.id === 'gap',
  'the same projection with no override is an ordinary gap, not a breach', noOverride.id);

/* A breach whose first short day IS the low returns that one date, and the page
 * is left to decide whether to print it twice. */
const oneDay = F.planStatus(FUNDABLE, { weeklyOverride: 1500,
  sim: sim({ buffer: 500, min: { date: '2026-08-27', balance: 431.09 },
    daily: [day('2026-08-12', 500), day('2026-08-27', 431.09)] }) });
ok(oneDay.firstBelowBuffer === '2026-08-27' && oneDay.lowDate === '2026-08-27',
  'a breach that never deepens returns the same date for both');

console.log('\n=== 3. a gap no single source covers ===');
/* Hand-computed. At a $3,000 buffer the gap is $3,543.16. Amanda's $2,691.85
 * is the top-ranked source and is taken in full; the HELOC supplies the
 * remaining $851.31 of its $1,067.84 room. Nothing is left unfunded.
 *
 *   borrowed      851.31   (the HELOC draw)
 *   non-borrowed 2691.85   (Amanda's own money)
 *   allocated    3543.16 = the gap, so shortfall is 0 */
const COMBINATION = advice({
  gap: gapOf(3543.16),
  funding: { parts: [{ id: 'amanda', short: "Amanda's transfer", amount: AMANDA, debtId: null },
    { id: 'heloc', short: 'a HELOC draw', amount: 851.31, debtId: 'heloc' }],
  allocated: 3543.16, shortfall: 0, feasible: true, needsCombination: true,
  borrowed: 851.31, free: AMANDA },
  sim: sim({ buffer: 3000, min: { date: GAP_DATE, balance: 3000 }, ending: 7489.20 }),
});
const combo = F.planStatus(COMBINATION, { weeklyOverride: null });
ok(combo.id === 'combination',
  'a gap that takes two sources selects the combination verdict', combo.id);
ok(combo.parts.length === 2 && same(combo.borrowed, 851.31),
  'and reports what is borrowed', String(combo.borrowed));
{
  const f = COMBINATION.funding;
  ok(same(f.borrowed + f.free, f.allocated),
    'borrowed + non-borrowed reconciles to the allocation',
    `${f.borrowed} + ${f.free} = ${f.allocated}`);
  ok(same(f.allocated + f.shortfall, COMBINATION.gap.amount),
    'and the allocation + shortfall reconciles to the gap');
}

/* The allocation taking two sources does NOT prove that no single source could
 * have covered the gap. Rank order fills the cheapest source first, so a small
 * rank-1 source and a large rank-2 source produce a two-part allocation while
 * rank 2 covers the whole gap on its own.
 *
 * The band claimed the stronger fact, and the source card below it — reading
 * the same funding result — said the opposite. Blocking review found it on
 * `b5770df`. It is the cross-surface contradiction this move exists to end,
 * so the verdict now states only what the allocation proves.
 *
 * Built through the REAL engine on the REAL plan, not a hand-made funding
 * object: the point is that `recommend` genuinely produces this pair.
 * Source sizes follow the live gap, so a cash refresh cannot collapse the
 * trap into a single-source cover. */
const trapBuffer = Math.max(500, Math.ceil(F.startingCashAmount(data.plan) + 400));
const trapGapAmt = Math.max(1, gapAtBuffer(data.plan, trapBuffer, data.meta.asOf));
const RANK_TRAP = [
  { id: 'small', label: 'Small', short: 'the small one', available: trapGapAmt * 0.4, rank: 1, debtId: null },
  { id: 'big', label: 'Big', short: 'the big one', available: trapGapAmt * 1.2, rank: 2, debtId: null },
];
const rankTrap = F.recommend(data.plan, data.meta.asOf, {
  scenario: data.plan.defaults.scenario, targetBuffer: trapBuffer, extraDebtMonthly: 0,
  incomeOverrides: {}, disabled: [], debts: data.debts,
  extraDebtTarget: data.plan.nextDollar.target, fundingSources: RANK_TRAP,
});
const rankTrapStatus = F.planStatus(rankTrap, { weeklyOverride: null });
{
  const f = rankTrap.funding;
  ok(f.needsCombination && f.parts.length === 2,
    'rank order really does allocate across two sources here',
    f.parts.map(p => `${p.id} ${p.amount.toFixed(2)}`).join(' + '));
  ok(f.sources.find(s => s.id === 'big').verdict === 'covers',
    'while the rank-2 source alone covers the whole gap',
    `big available 1500 vs gap ${rankTrap.gap.amount.toFixed(2)}`);
  ok(rankTrapStatus.id === 'combination',
    'the verdict is still the combination one — the allocation is what it is',
    rankTrapStatus.id);
  ok(rankTrapStatus.noSingleSourceCovers === false,
    'but it no longer claims no single source covers the gap',
    String(rankTrapStatus.noSingleSourceCovers));
}
// And the published live sources no longer combine: Q25 keeps Amanda at $0,
// and HELOC capacity is not automatic opening-gap cash.
{
  const combineBuf = (() => {
    const src = fundingById(data.plan, data.revolvingExtra, data.debts);
    return src.heloc.available / 2 + openingFloor(data.plan, data.meta.asOf);
  })();
  const adv = F.recommend(data.plan, data.meta.asOf, Object.assign({
    scenario: data.plan.defaults.scenario, targetBuffer: combineBuf, extraDebtMonthly: 0,
    incomeOverrides: {}, disabled: [], debts: data.debts,
    extraDebtTarget: data.plan.nextDollar.target,
    extraFacilities: data.revolvingExtra,
  }, { fundingSources: data.plan.funding.options }));
  const s = F.planStatus(adv, { weeklyOverride: null });
  const amanda = (adv.funding.sources || []).find(x => x.id === 'amanda');
  ok(s.id === 'unfunded',
    'on the published plan a mid-sized gap is unfunded while Q25 is OPEN and HELOC is not auto-drawn');
  ok(amanda && same(amanda.available, 0) && amanda.verdict === 'insufficient',
    'Amanda\'s held-elsewhere locator contributes no funding capacity',
    amanda ? `${amanda.verdict} ${amanda.available}` : 'missing');
}

console.log('\n=== 4. an ordinary opening gap ===');
/* Hand-computed. $1,043.16 short at the floor, covered by one source, no
 * override: a timing problem, and the verdict says so. */
const plain = F.planStatus(FUNDABLE, { weeklyOverride: null });
ok(plain.id === 'gap', 'a fundable single-source gap selects the ordinary gap verdict', plain.id);
ok(same(plain.gapAmount, 1043.16) && same(plain.preIncomeOut, 623)
  && plain.floorDate === GAP_DATE && plain.effectiveFrom === '2026-08-14',
  'and carries the gap, the committed payments before payday, the floor date and the date spending resumes');

console.log('\n=== 5. no opening gap, and the account goes negative ===');
/* Hand-computed. No gap at all. The run dips under the $500 buffer on
 * 17 August, which is NOT what this verdict is about — it goes negative on
 * 24 August and keeps falling to −$212.40 on 31 August. The date named is the
 * first negative day, not the first short one. */
const NEGATIVE_SIM = sim({ buffer: 500,
  min: { date: '2026-08-31', balance: -212.40 },
  daily: [day('2026-08-10', 900), day('2026-08-17', 300),
    day('2026-08-24', -45.10), day('2026-08-31', -212.40)] });
const negative = F.planStatus(advice({ sim: NEGATIVE_SIM }), { weeklyOverride: null });
ok(negative.id === 'negative', 'a negative projection with no gap selects the negative verdict', negative.id);
ok(negative.firstNegative === '2026-08-24',
  'and returns the first NEGATIVE day, not the first below-buffer day',
  String(negative.firstNegative));
ok(same(negative.low, -212.40) && negative.lowDate === '2026-08-31',
  'with the low it keeps falling to');

console.log('\n=== 6. below the buffer, but never negative ===');
const belowBuffer = F.planStatus(advice({
  sim: sim({ buffer: 500, min: { date: '2026-08-27', balance: 431.09 }, ending: 2100,
    daily: [day('2026-08-27', 431.09)] }) }), { weeklyOverride: null });
ok(belowBuffer.id === 'belowBuffer',
  'a below-buffer but non-negative projection selects the warning verdict', belowBuffer.id);
ok(same(belowBuffer.low, 431.09) && same(belowBuffer.buffer, 500)
  && same(belowBuffer.ending, 2100) && belowBuffer.end === '2026-11-07',
  'and carries the dip, the buffer, the ending and the window end');

console.log('\n=== 7. above the buffer all the way through ===');
const onPlan = F.planStatus(advice({}), { weeklyOverride: null });
ok(onPlan.id === 'onPlan', 'an above-buffer projection selects the on-plan verdict', onPlan.id);
ok(same(onPlan.ending, 4200) && same(onPlan.low, 1200) && onPlan.lowDate === AS_OF,
  'and carries the ending and the low it never went under');

console.log('\n=== 7b. recommend already marked the protected plan INFEASIBLE ===');
/* Copied from advice.infeasible — the band must not re-decide. A buffer-holding
 * simulation with mode infeasible is the B94/B96 case the old seven-verdict
 * band would have published as onPlan. */
const infeasibleAdvice = advice({
  mode: 'infeasible',
  infeasible: {
    kind: 'encumbered', date: '2026-11-07', shortfall: 1200,
    label: 'Christmas 2026',
  },
});
const infeasible = F.planStatus(infeasibleAdvice, { weeklyOverride: null });
ok(infeasible.id === 'infeasible',
  'an infeasible recommend result selects INFEASIBLE, not onPlan', infeasible.id);
ok(same(infeasible.shortfall, 1200) && infeasible.label === 'Christmas 2026'
  && infeasible.date === '2026-11-07' && same(infeasible.buffer, 500),
  'and copies the first failing constraint from advice.infeasible');

console.log('\n=== 8. the boundary is the engine\'s epsilon, in both directions ===');
/* The page compared the dip against a bare `sim.min.balance < sim.buffer` while
 * testing the override breach against `sim.buffer - 0.005`. Two conventions in
 * one block, and the bare one is wrong at the boundary: a float landing a
 * ten-thousandth of a cent under $500 published "Tight — projected to dip to
 * $500 … below the $500 target buffer", a sentence contradicting itself inside
 * its own clause, while `recommend` reported the same run as holding.
 *
 * `below()` is the engine's convention and EPSILON is half a cent, so a figure
 * within it is the buffer, and a real cent under it is not. */
const AT_BUFFER = 500 - 1e-9;
const boundary = F.planStatus(advice({
  sim: sim({ buffer: 500, min: { date: '2026-08-27', balance: AT_BUFFER },
    daily: [day('2026-08-27', AT_BUFFER)] }) }), { weeklyOverride: null });
ok(boundary.id === 'onPlan',
  'a float a ten-thousandth of a cent under the buffer is ON the buffer', boundary.id);
ok(AT_BUFFER < 500,
  'and the old bare comparison really would have called that day a dip',
  `${AT_BUFFER} < 500`);
const realCent = F.planStatus(advice({
  sim: sim({ buffer: 500, min: { date: '2026-08-27', balance: 499.99 },
    daily: [day('2026-08-27', 499.99)] }) }), { weeklyOverride: null });
ok(realCent.id === 'belowBuffer',
  'and a genuine cent under the buffer is still a dip', realCent.id);
ok(F.EPSILON === 0.005, 'the epsilon being used is the engine\'s own', String(F.EPSILON));

// Without a simulation every figure in every verdict is missing, and the
// unfundable branch would still render — publishing "unfunded at a $0 buffer".
{
  let threw = false;
  try { F.planStatus({ gap: gapOf(100), funding: { feasible: false, shortfall: 100, allocated: 0 } }, {}); }
  catch { threw = true; }
  ok(threw, 'a verdict asked for without a simulation throws rather than publishing a $0 buffer');
}

// The same convention decides the override breach, from one place. A setting
// that lands within epsilon of the buffer is not a breach.
const noBreachAtBoundary = F.planStatus(FUNDABLE, { weeklyOverride: 1500,
  sim: sim({ buffer: 500, min: { date: '2026-08-27', balance: AT_BUFFER },
    daily: [day('2026-08-27', AT_BUFFER)] }) });
ok(noBreachAtBoundary.id === 'gap',
  'an override that lands on the buffer within epsilon is not a breach',
  noBreachAtBoundary.id);

console.log('\n=== 9. per-source funding verdicts, on the published plan ===');
/* Live sources while Q25 is OPEN: Amanda's held-elsewhere locator is $0
 * available, so usable capacity is the HELOC only. Overdraft and cards stay
 * unusable and are excluded from the allocation.
 *
 * A just-above-floor gap is covered by the HELOC alone.
 * A gap of HELOC/2 is still a single-source cover.
 * A gap beyond HELOC room is unfunded. Combination of two positive sources
 * is proved on the RANK_TRAP / COMBINATION fixtures above, not by treating
 * the TENNIS INCOME raw balance as authorized household funding. */
const plan = data.plan, asOf = data.meta.asOf;
const OPTS = targetBuffer => ({
  scenario: plan.defaults.scenario, targetBuffer,
  extraDebtMonthly: plan.defaults.extraDebtMonthly, incomeOverrides: {},
  disabled: [], debts: data.debts, extraDebtTarget: plan.nextDollar.target,
  fundingSources: plan.funding.options,
  extraFacilities: data.revolvingExtra,
});
const bySource = adv => Object.fromEntries((adv.funding && adv.funding.sources || []).map(s => [s.id, s]));
const src = fundingById(plan, data.revolvingExtra, data.debts);
const odAvailable = F.resolveFundingSources(
  plan.funding.options, data.revolvingExtra, plan, data.debts
).find(o => o.id === 'overdraft').available;
const floor = openingFloor(plan, asOf);
const COMBINE_GAP = 800;
const COMBINE_BUF = COMBINE_GAP + floor;
const CONTRIB_BUF = 900 + floor;
const UNFUNDED_GAP = usableFunding(plan, data.revolvingExtra, data.debts) + 1000;
const UNFUNDED_BUF = UNFUNDED_GAP + floor;
const expectedVerdict = (available, gap) => {
  if (!(Number(available) > 0.005)) return 'insufficient';
  return available + 0.005 >= gap ? 'covers' : 'contributes';
};

{
  const buf = Math.max(plan.defaults.targetBuffer, Math.ceil(floor + 50));
  const wantGap = gapAtBuffer(plan, buf, asOf);
  const adv = F.recommend(plan, asOf, OPTS(buf));
  const s = bySource(adv);
  ok(adv.funding && same(adv.gap.amount, wantGap), 'a just-above-floor buffer sizes the gap from the floor', adv.gap ? String(adv.gap.amount) : 'none');
  ok(same(src.amanda.available, 0) && s.amanda.verdict === expectedVerdict(src.amanda.available, wantGap),
    'Amanda\'s held-elsewhere locator is not a cover or contribution while Q25 is OPEN', s.amanda.verdict);
  ok(s.heloc.verdict === 'insufficient' && same(s.heloc.contributes, 0),
    'HELOC capacity is visible but does not cover an opening gap', s.heloc.verdict);
  ok(s.overdraft.verdict === 'insufficient'
    && same(s.overdraft.shortBy, Math.max(0, wantGap - odAvailable)),
    'the overdraft is short by gap minus its room', String(s.overdraft.shortBy));
  ok(s.cards.verdict === 'insufficient'
    && same(s.cards.shortBy, Math.max(0, wantGap - src.cards.available)),
    'and the cards by gap minus theirs', String(s.cards.shortBy));
  ok(adv.funding.sources.map(x => x.id).join(',') === 'amanda,heloc,overdraft,cards',
    'the sources come back in rank order', adv.funding.sources.map(x => x.id).join(','));
}
{
  const adv = F.recommend(plan, asOf, OPTS(COMBINE_BUF));
  const s = bySource(adv);
  const wantGap = gapAtBuffer(plan, COMBINE_BUF, asOf);
  ok(same(adv.gap.amount, wantGap), 'a mid-sized cash-only gap is sized from the floor', String(adv.gap.amount));
  ok(s.amanda.verdict === 'insufficient' && same(s.amanda.contributes, 0),
    'Amanda contributes nothing from the held-elsewhere raw balance',
    `${s.amanda.verdict} ${s.amanda.contributes}`);
  ok(s.heloc.verdict === 'insufficient' && same(s.heloc.contributes, 0),
    'the HELOC does not auto-cover that mid-sized gap',
    `${s.heloc.verdict} ${s.heloc.contributes}`);
  ok(adv.funding && adv.funding.feasible === false && same(adv.funding.shortfall, wantGap),
    'without a cash source the gap remains unfunded', String(adv.funding && adv.funding.shortfall));
  ok(s.overdraft.verdict === 'insufficient' && s.cards.verdict === 'insufficient',
    'the unusable sources stay unused');
  const contributed = adv.funding.sources.reduce((a, x) => a + x.contributes, 0);
  ok(same(contributed + adv.funding.shortfall, adv.gap.amount),
    'sum(contributions) + shortfall = the gap',
    `${contributed} + ${adv.funding.shortfall} = ${adv.gap.amount}`);
  ok(same(contributed, adv.funding.allocated),
    'and the per-source contributions total the allocation');
}
{
  // Beyond every source combined: the allocation stops at what exists, and the
  // identity still holds with a non-zero shortfall.
  const adv = F.recommend(plan, asOf, OPTS(UNFUNDED_BUF));
  const contributed = adv.funding.sources.reduce((a, x) => a + x.contributes, 0);
  const usable = usableFunding(plan, data.revolvingExtra, data.debts);
  ok(!adv.funding.feasible && same(contributed, usable)
    && same(adv.funding.shortfall, gapAtBuffer(plan, UNFUNDED_BUF, asOf) - usable),
    'an unfundable gap allocates every usable source and leaves the rest',
    `${contributed} / ${adv.funding.shortfall}`);
  ok(same(contributed + adv.funding.shortfall, adv.gap.amount),
    'sum(parts) + shortfall = the gap, unfunded as well as funded');
  ok(adv.funding.sources.every(x => x.verdict !== 'covers'),
    'and no source claims to cover a gap none of them can reach');
}
{
  // An unusable source is never a cover, however large its balance: it is
  // excluded from the allocation, so offering it would offer money the plan
  // cannot spend.
  const rich = plan.funding.options.map(o =>
    o.id === 'overdraft' ? Object.assign({}, o, { available: 999999, cash: undefined }) : o);
  const buf = Math.max(plan.defaults.targetBuffer, Math.ceil(floor + 50));
  const adv = F.recommend(plan, asOf,
    Object.assign(OPTS(buf), { fundingSources: rich }));
  const s = bySource(adv);
  ok(s.overdraft && s.overdraft.verdict === 'insufficient' && same(s.overdraft.shortBy, 0),
    'an unusable source with more than enough is still not a cover',
    s.overdraft ? `${s.overdraft.verdict} ${s.overdraft.shortBy}` : 'missing');
  ok(!(adv.funding.parts || []).some(p => p.id === 'overdraft'),
    'and the unusable overdraft is left out of the allocation');
  ok(adv.funding && adv.funding.feasible === false,
    'HELOC capacity does not silently replace it');
}
{
  // The coverage comparison uses the engine's own epsilon, so it cannot
  // disagree with the allocation that stops on the same one: a source half a
  // cent short funds the gap, and must not be reported as failing to.
  const hairBuf = Math.max(500, Math.ceil(floor + 50));
  const gapBase = F.recommend(plan, asOf, OPTS(hairBuf));
  const gapAt500 = gapBase.gap ? gapBase.gap.amount : 50;
  const hair = [{ id: 'hair', label: 'Hair-short source', short: 'it',
    available: gapAt500 - 0.004, rank: 1, debtId: null }];
  const adv = F.recommend(plan, asOf, Object.assign(OPTS(hairBuf), { fundingSources: hair }));
  ok(adv.funding.feasible, 'a source half a cent short still funds the gap');
  ok(adv.funding.sources[0].verdict === 'covers',
    'and the card says so rather than "$0 short"', adv.funding.sources[0].verdict);
}

console.log('\n=== 10. mutation: breaking the engine breaks the answer ===');
/* Mutate the engine source, load the mutant, and require it to disagree with
 * the real engine on a case above. A decision that survives being broken was
 * not being tested — which is exactly what B73 recorded about these two blocks
 * while they lived in the page. */
const FORECAST_SRC = read('public/forecast.js');
function mutant(from, to) {
  from = sourceText(from);
  to = sourceText(to);
  const occurrences = FORECAST_SRC.split(from).length - 1;
  if (occurrences !== 1) return { error: `target appears ${occurrences} time(s)` };
  const sandbox = { module: { exports: {} } };
  try {
    vm.runInNewContext(FORECAST_SRC.replace(from, to), sandbox, { filename: 'forecast-mutant.js' });
  } catch (e) { return { error: e.message }; }
  return { engine: sandbox.module.exports };
}
const realStatus = { unfunded, breach, combo, plain, negative, belowBuffer, onPlan, infeasible };

const MUTATIONS = [
  { label: 'dropping the infeasible branch publishes onPlan beside a failed protected plan',
    from: '    if (advice.mode === \'infeasible\' && advice.infeasible) {',
    to: '    if (false && advice.mode === \'infeasible\' && advice.infeasible) {',
    check: m => m.planStatus(infeasibleAdvice, { weeklyOverride: null }).id === 'onPlan',
    real: () => infeasible.id === 'infeasible' },

  { label: 'testing the override breach before the funding shortfall blames spending for an unfundable gap',
    from: `    if (gap && fundingShort) {
      return { id: 'unfunded', gapAmount, floorDate: gap.floorDate,
        allocated: funding.allocated, shortfall: funding.shortfall, buffer };
    }
    if (gap && overrideBreaches) {`,
    to: `    if (gap && overrideBreaches) {`,
    check: m => m.planStatus(UNFUNDABLE, { weeklyOverride: 1500,
      sim: sim({ buffer: 5000, min: { date: '2026-09-10', balance: -809.12 } }) }).id === 'overrideBreach',
    real: () => unfundedWithOverride.id === 'unfunded' },

  { label: 'halving the dip threshold hides a below-buffer projection',
    from: '    if (below(sim.min.balance, buffer)) {',
    to: '    if (below(sim.min.balance, buffer / 2)) {',
    check: m => m.planStatus(advice({
      sim: sim({ buffer: 500, min: { date: '2026-08-27', balance: 431.09 },
        daily: [day('2026-08-27', 431.09)] }) }), { weeklyOverride: null }).id === 'onPlan',
    real: () => realStatus.belowBuffer.id === 'belowBuffer' },

  { label: 'dropping the funding-date floor picks a breach the funding already fixes',
    from: '      const firstBad = daily.find(p => p.date >= gap.date && below(p.balance, buffer));',
    to: '      const firstBad = daily.find(p => below(p.balance, buffer));',
    check: m => m.planStatus(FUNDABLE, { weeklyOverride: 1500, sim: BREACHING_SIM })
      .firstBelowBuffer === '2026-08-10',
    real: () => realStatus.breach.firstBelowBuffer === '2026-08-27' },

  { label: 'testing the negative branch against the buffer calls a dip a shortfall',
    from: '    if (below(sim.min.balance, 0)) {',
    to: '    if (sim.min.balance < 500) {',
    check: m => m.planStatus(advice({
      sim: sim({ buffer: 500, min: { date: '2026-08-27', balance: 431.09 },
        daily: [day('2026-08-27', 431.09)] }) }), { weeklyOverride: null }).id === 'negative',
    real: () => realStatus.belowBuffer.id === 'belowBuffer' },

  { label: 'selecting the first below-buffer day as the first negative day misdates the shortfall',
    from: '      const firstNeg = daily.find(p => below(p.balance, 0));',
    to: '      const firstNeg = daily.find(p => below(p.balance, buffer));',
    check: m => m.planStatus(advice({ sim: NEGATIVE_SIM }), { weeklyOverride: null })
      .firstNegative === '2026-08-17',
    real: () => realStatus.negative.firstNegative === '2026-08-24' },

  { label: 'dropping the combination test reports a two-source gap as an ordinary one',
    from: '    if (gap && funding && funding.needsCombination) {',
    to: '    if (false) {',
    check: m => m.planStatus(COMBINATION, { weeklyOverride: null }).id === 'gap',
    real: () => realStatus.combo.id === 'combination' },

  { label: 'reading the combination opening off the allocation alone recreates the contradiction',
    from: `      const noSingleSourceCovers = !(funding.sources || [])
        .some(s => s.verdict === 'covers');`,
    to: '      const noSingleSourceCovers = true;',
    check: m => m.planStatus(m.recommend(data.plan, data.meta.asOf, {
      scenario: data.plan.defaults.scenario, targetBuffer: trapBuffer, extraDebtMonthly: 0,
      incomeOverrides: {}, disabled: [], debts: data.debts,
      extraDebtTarget: data.plan.nextDollar.target, fundingSources: RANK_TRAP,
    }), { weeklyOverride: null }).noSingleSourceCovers === true,
    real: () => rankTrapStatus.noSingleSourceCovers === false },

  { label: 'halving the coverage comparison makes a source that cannot cover the gap claim it can',
    from: '        const covers = canAutoCoverOpeningGap(src) && atLeast(src.available, gapAmount);',
    to: '        const covers = canAutoCoverOpeningGap(src) && atLeast(src.available, gapAmount / 2);',
    check: m => {
      const overlay = plan.funding.options.map(o =>
        o.id === 'amanda' ? Object.assign({}, o, { cash: undefined, available: 800 }) : o);
      return bySource(m.recommend(plan, asOf,
        Object.assign(OPTS(CONTRIB_BUF), { fundingSources: overlay }))).amanda.verdict === 'covers';
    },
    real: () => {
      const overlay = plan.funding.options.map(o =>
        o.id === 'amanda' ? Object.assign({}, o, { cash: undefined, available: 800 }) : o);
      return bySource(F.recommend(plan, asOf,
        Object.assign(OPTS(CONTRIB_BUF), { fundingSources: overlay }))).amanda.verdict === 'contributes';
    } },

  { label: 'dropping the unusable guard offers money the plan cannot spend',
    from: '    if (!src || src.unusable === true) return false;',
    to: '    if (!src) return false;',
    check: m => {
      const rich = plan.funding.options.map(o =>
        o.id === 'overdraft' ? Object.assign({}, o, { available: 999999, cash: undefined }) : o);
      return bySource(m.recommend(plan, asOf,
        Object.assign(OPTS(Math.max(500, Math.ceil(floor + 50))), { fundingSources: rich }))).overdraft.verdict === 'covers';
    },
    real: () => {
      const rich = plan.funding.options.map(o =>
        o.id === 'overdraft' ? Object.assign({}, o, { available: 999999, cash: undefined }) : o);
      return bySource(F.recommend(plan, asOf,
        Object.assign(OPTS(Math.max(500, Math.ceil(floor + 50))), { fundingSources: rich }))).overdraft.verdict === 'insufficient';
    } },

  { label: 'reversing the per-source shortfall reports the wrong figure short',
    from: '          shortBy: src.debtId && !src.unusable\n            ? gapAmount\n            : Math.max(0, gapAmount - src.available),',
    to: '          shortBy: src.debtId && !src.unusable\n            ? gapAmount\n            : Math.max(0, src.available - gapAmount),',
    check: m => cents(bySource(m.recommend(plan, asOf, OPTS(COMBINE_BUF))).overdraft.shortBy) === 0,
    real: () => same(bySource(F.recommend(plan, asOf, OPTS(COMBINE_BUF))).overdraft.shortBy,
      Math.max(0, gapAtBuffer(plan, COMBINE_BUF, asOf) - odAvailable)) },

  { label: 'totalling the allocation from the gap instead of the parts hides the shortfall',
    from: '    const allocated = parts.reduce((s, p) => s + p.amount, 0);',
    to: '    const allocated = gapAmount;',
    check: m => same(m.recommend(plan, asOf, OPTS(UNFUNDED_BUF)).funding.allocated,
      gapAtBuffer(plan, UNFUNDED_BUF, asOf)),
    real: () => same(F.recommend(plan, asOf, OPTS(UNFUNDED_BUF)).funding.allocated,
      usableFunding(plan, data.revolvingExtra, data.debts)) },
];
for (const m of MUTATIONS) {
  const built = mutant(m.from, m.to);
  if (built.error) { ok(false, m.label, built.error); continue; }
  ok(m.check(built.engine) && m.real(), m.label);
}

console.log('\n=== 11. the page renders, and has words for every verdict ===');
/* The page's wording maps and the real formatters it uses, lifted from the
 * production sources rather than copied — a copy would prove the copy. */
const planSrc = read('public/plan.js');
const appSrc = read('public/app.js');
const grab = (src, re, what) => {
  const m = re.exec(src);
  ok(!!m, `${what} is readable from its source`);
  return m ? m[0] : '';
};
const FORMATTERS = [
  grab(appSrc, /^const money = .*$/m, 'money()'),
  grab(appSrc, /^const money2 = .*$/m, 'money2()'),
  grab(appSrc, /^const pct = .*$/m, 'pct()'),
  grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate()'),
  grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong()'),
].join('\n');
const BAND_SRC = grab(planSrc, /^const STATUS_BAND = \{[\s\S]*?^\};$/m, 'the band wording map');
const FUND_SRC = grab(planSrc, /^const FUND_VERDICT = \{[\s\S]*?^\};$/m, 'the funding wording map');
const [STATUS_BAND, FUND_VERDICT] = vm.runInNewContext(
  `${FORMATTERS}\n${BAND_SRC}\n${FUND_SRC}\n[STATUS_BAND, FUND_VERDICT];`,
  { Forecast: F, escapeHtml: require('./app-escape-html') });

const statusSrc = /\n  function planStatus\(advice, opts\) \{[\s\S]*?\n  \}\n/.exec(FORECAST_SRC);
ok(!!statusSrc, 'the planStatus function is readable from forecast.js');
const engineIds = [...new Set([...(statusSrc ? statusSrc[0] : '')
  .matchAll(/\bid: '([A-Za-z]+)'/g)].map(m => m[1]))].sort();
const wordedIds = Object.keys(STATUS_BAND).sort();
ok(engineIds.length === 9, 'the engine emits eight financial verdicts plus unavailable', engineIds.join(', '));
ok(engineIds.every(id => wordedIds.includes(id)),
  'the page has wording for every verdict the engine can emit',
  engineIds.filter(id => !wordedIds.includes(id)).join(', ') || 'none missing');
ok(wordedIds.every(id => engineIds.includes(id)),
  'and no wording is left behind for a verdict the engine cannot emit',
  wordedIds.filter(id => !engineIds.includes(id)).join(', ') || 'none stale');
ok(wordedIds.every(id => ['crit', 'warn', 'good'].includes(STATUS_BAND[id].tone)),
  'every verdict maps to a real tone class');

const recommendSrc = /\n  function recommend\(plan, asOf, opts\) \{[\s\S]*?\n  \}\n/.exec(FORECAST_SRC);
const engineVerdicts = ['covers', 'contributes', 'insufficient'];
ok(!!recommendSrc && engineVerdicts.every(v =>
  new RegExp(`'${v}'`).test(recommendSrc[0])),
'the engine emits the three funding verdicts');
ok(Object.keys(FUND_VERDICT).sort().join(',') === engineVerdicts.slice().sort().join(','),
  'and the page words exactly those three', Object.keys(FUND_VERDICT).join(','));

// The page no longer decides. These are the exact expressions it used.
ok(/Forecast\.planStatus\(/.test(planSrc), 'the Plan page reads the status from Forecast');
ok(!/const overrideBreaches =/.test(planSrc),
  'and no longer hand-copies the engine\'s buffer comparison and epsilon');
ok(!/sim\.buffer - 0\.005/.test(planSrc), 'the copied epsilon literal is gone from the page');
ok(!/const fundingShort =/.test(planSrc), 'it does not re-derive whether the gap can be funded');
// The band picked two dates by walking the daily balances against a threshold —
// the first breach and the first negative day. Both selections moved. What is
// left in the page is a lookup of a KNOWN date, which decides nothing.
{
  const dailyFinds = [...planSrc.matchAll(/\.daily\.find\(([^;]*?)\);/g)].map(m => m[1]);
  ok(dailyFinds.every(f => !/balance\s*</.test(f)),
    'it selects no date by comparing a daily balance against a threshold',
    dailyFinds.join(' | ') || 'no daily lookups at all');
}
ok(!/fundingPlan\.parts\.reduce\(/.test(planSrc),
  'and totals no funding parts of its own');
ok(!/const enough = o\.available >= needed/.test(planSrc),
  'the per-source coverage comparison is gone');
ok(!/needed - o\.available/.test(planSrc), 'and so is the per-source shortfall arithmetic');
ok(!/plan\.funding\.options\s*\n?\s*\.slice\(\)\.sort/.test(planSrc),
  'the page no longer ranks the funding sources itself');

console.log('\n=== 12. migration equivalence on the real published plan ===');
/* Both verdicts the household reads today, both ways. `legacyBand` and
 * `legacyCards` are the expressions public/plan.js ran before this move,
 * character for character; the moved versions are the engine's decision
 * rendered through the page's own wording maps. Ten settings, so the
 * equivalence covers every branch the published data can reach.
 *
 * Compared with runs of whitespace collapsed, because that is what an HTML
 * renderer does with them and therefore what the household actually reads —
 * the wording moved into a map at a different indentation. */
const flat = s => s.replace(/\s+/g, ' ').trim();

function published({ targetBuffer, weeklyVariable }) {
  const adv = F.recommend(plan, asOf, OPTS(targetBuffer));
  const recommended = adv.weekly;
  const weekly = weeklyVariable != null ? weeklyVariable : recommended;
  const showing = weekly === recommended ? adv.sim
    : F.simulate(plan, asOf, Object.assign({}, adv.simOptions, { weeklyVariable: weekly }));
  return { adv, sim: showing, weekly, recommended, weeklyVariable };
}

const [money, money2, pct, fmtDate, fmtDateLong] = vm.runInNewContext(
  `${FORMATTERS}\n[money, money2, pct, fmtDate, fmtDateLong];`);

function legacyBand({ adv, sim, weekly, recommended, weeklyVariable }) {
  // Copied from public/plan.js as it stood at fb9ced8, unchanged.
  const fundingPlan = adv.funding || null;
  const fundingShort = !!(fundingPlan && !fundingPlan.feasible);
  const gap = adv.gap;
  const fundingGap = gap ? gap.amount : 0;
  const preIncomeOut = gap ? gap.preIncomeOut : 0;
  const overrideBreaches = weeklyVariable != null && sim.min.balance < sim.buffer - 0.005;
  if (gap && fundingShort) {
    return ['statusband crit',
      `<b>Short by ${money(fundingGap)} on ${fmtDateLong(gap.floorDate)}, and there is not enough
       anywhere to cover it.</b> Every usable source combined reaches
       ${money2(fundingPlan.parts.reduce((a, p) => a + p.amount, 0))}, leaving
       <b>${money2(fundingPlan.shortfall)}</b> unfunded at a ${money(sim.buffer)} buffer. No weekly spending
       figure fixes this — lower the buffer, move a commitment, or find money outside these accounts.`];
  } else if (gap && overrideBreaches) {
    const firstBad = sim.daily.find(p =>
      (!gap || p.date >= gap.date) && p.balance < sim.buffer - 0.005);
    return ['statusband crit',
      `<b>${money(weekly)}/week does not work${sim.min.balance < 0 ? ' — the account goes negative' : ''}.</b>
       Even with the ${money(fundingGap)} gap covered, spending at your setting takes the balance to
       ${money(sim.min.balance)} by ${fmtDateLong(sim.min.date)}${firstBad && firstBad.date !== sim.min.date
        ? `, first slipping below the buffer on ${fmtDateLong(firstBad.date)}` : ''}.
       The forecast supports <b>${money(recommended)}/week</b>.`];
  } else if (gap && fundingPlan && fundingPlan.needsCombination) {
    return ['statusband crit',
      `<b>Short by ${money(fundingGap)} on ${fmtDateLong(gap.floorDate)}, and no single source covers it.</b>
       It takes ${fundingPlan.parts.map(p => `${money2(p.amount)} from ${p.short}`).join(' plus ')}.
       ${fundingPlan.borrowed > 0
        ? `<b>${money2(fundingPlan.borrowed)} of that is borrowed</b>, and the debt figures below carry it.`
        : 'None of it is borrowed.'}
       Hold spending to ${money(weekly)}/week from ${fmtDateLong(adv.effectiveFrom)} and the window
       finishes with ${money(sim.ending)}.`];
  } else if (gap) {
    return ['statusband crit',
      `<b>Short by ${money(fundingGap)} on ${fmtDateLong(gap.floorDate)} — before any spending at all.</b>
       The household accounts hold ${money2(F.startingCashAmount(plan))} today and
       ${money(preIncomeOut)} of committed payments fall before the next payday.
       This is a timing gap, not a shortage across the 90 days: cover it, hold spending to
       ${money(weekly)}/week from ${fmtDateLong(adv.effectiveFrom)}, and the window
       finishes with ${money(sim.ending)}.`];
  } else if (sim.min.balance < 0) {
    const firstNeg = sim.daily.find(p => p.balance < 0);
    return ['statusband crit', `<b>Shortfall expected around ${fmtDateLong(firstNeg.date)}.</b>
         At this spending level the account goes negative${firstNeg.date !== sim.min.date
      ? ` and keeps falling, reaching ${money(sim.min.balance)} by ${fmtDateLong(sim.min.date)}`
      : ` (${money(sim.min.balance)})`}.
         Cut the weekly budget, move a commitment, or bring income forward.`];
  } else if (sim.min.balance < sim.buffer) {
    return ['statusband warn', `<b>Tight — projected to dip to ${money(sim.min.balance)} on ${fmtDateLong(sim.min.date)}</b>,
      below the ${money(sim.buffer)} target buffer, then recover to ${money(sim.ending)} by ${fmtDate(sim.end)}.`];
  }
  return ['statusband good', `<b>On plan — projected to finish with ${money(sim.ending)}.</b>
      The balance stays above the ${money(sim.buffer)} buffer all the way through, with the low of
      ${money(sim.min.balance)} on ${fmtDateLong(sim.min.date)}.`];
}

function legacyCards({ adv }) {
  // Copied from public/plan.js as it stood at fb9ced8, unchanged.
  const fundingPlan = adv.funding || null;
  const gap = adv.gap;
  if (!gap || !plan.funding) return '';
  const needed = gap.amount;
  return F.resolveFundingSources(plan.funding.options, data.revolvingExtra, plan, data.debts)
    .slice().sort((a, b) => a.rank - b.rank)
    .map(o => {
      const cashAvail = o.debtId ? 0 : o.available;
      const enough = !o.unusable && !o.debtId && o.available >= needed;
      const part = fundingPlan && fundingPlan.parts.find(p => p.id === o.id);
      return `<div class="fund ${o.unusable || !enough ? 'fund-no' : 'fund-yes'}">
          <div class="fund-top">
            <span class="fund-lab">${o.label}</span>
            <span class="fund-amt">${money2(o.available)}${o.rate ? ` <span class="mutedtext">at ${pct(o.rate)}</span>` : ''}</span>
          </div>
          <div class="fund-verdict">${enough && !o.unusable
        ? `<span class="ok">Covers the whole ${money(needed)}</span>`
        : part
          ? `<span class="ok">Covers ${money2(part.amount)} of the ${money(needed)}</span> <span class="mutedtext">— used in the plan, with the rest from elsewhere</span>`
          : `<span class="no">Not enough — ${money(Math.max(0, needed - cashAvail))} short of the ${money(needed)} needed</span>`}</div>
          <p class="fund-note">${o.note}</p>
        </div>`;
    }).join('');
}

function movedBand(inputs) {
  const s = F.planStatus(inputs.adv,
    { weeklyOverride: inputs.weeklyVariable, sim: inputs.sim });
  return ['statusband ' + STATUS_BAND[s.id].tone, STATUS_BAND[s.id].text(s, plan), s.id];
}

function movedCards({ adv }) {
  const gap = adv.gap;
  if (!gap || !plan.funding) return '';
  const needed = gap.amount;
  const copyFor = new Map(plan.funding.options.map(o => [o.id, o]));
  return adv.funding.sources.map(s => {
    const o = copyFor.get(s.id);
    const verdict = FUND_VERDICT[s.verdict];
    return `<div class="fund ${verdict.cls}">
          <div class="fund-top">
            <span class="fund-lab">${o.label}</span>
            <span class="fund-amt">${money2(s.available)}${o.rate ? ` <span class="mutedtext">at ${pct(o.rate)}</span>` : ''}</span>
          </div>
          <div class="fund-verdict">${verdict.text(s, needed)}</div>
          <p class="fund-note">${o.note}</p>
        </div>`;
  }).join('');
}

const defBuf = plan.defaults.targetBuffer;
const recWeekly = F.recommend(plan, asOf, OPTS(defBuf)).weekly;
const overWeekly = Math.max(recWeekly + 500, 2500);
const SETTINGS = [
  { what: 'the published default buffer, no override', targetBuffer: defBuf, weeklyVariable: null, expect: 'onPlan' },
  { what: 'default buffer, an over-cap weekly override', targetBuffer: defBuf, weeklyVariable: overWeekly, expect: 'negative' },
  { what: 'a mid-sized gap HELOC capacity cannot auto-cover', targetBuffer: COMBINE_BUF, weeklyVariable: null, expect: 'unfunded' },
  { what: 'that mid-sized gap, an over-cap override', targetBuffer: COMBINE_BUF, weeklyVariable: overWeekly, expect: 'unfunded' },
  { what: 'a gap beyond every usable source', targetBuffer: UNFUNDED_BUF, weeklyVariable: null, expect: 'unfunded' },
  { what: 'that unfunded gap, an over-cap override', targetBuffer: UNFUNDED_BUF, weeklyVariable: overWeekly, expect: 'unfunded' },
];
const seen = new Set();
for (const s of SETTINGS) {
  const inputs = published(s);
  const [oldCls, oldHtml] = legacyBand(inputs);
  const [newCls, newHtml, id] = movedBand(inputs);
  seen.add(id);
  ok(oldCls === newCls && flat(oldHtml) === flat(newHtml),
    `identical status band — ${s.what}`,
    flat(oldHtml) === flat(newHtml) && oldCls === newCls
      ? `${id}: ${flat(newHtml).slice(0, 72)}…`
      : `\n      old: ${oldCls} | ${flat(oldHtml)}\n      new: ${newCls} | ${flat(newHtml)}`);
  ok(id === s.expect, `and it takes the expected branch, not an empty one — ${s.what}`, id);
  ok(flat(legacyCards(inputs)) === flat(movedCards(inputs)),
    `identical funding cards — ${s.what}`,
    flat(legacyCards(inputs)) === flat(movedCards(inputs)) ? ''
      : `\n      old: ${flat(legacyCards(inputs))}\n      new: ${flat(movedCards(inputs))}`);
}
ok(['onPlan', 'negative', 'unfunded'].every(id => seen.has(id)),
  'the published data reaches onPlan, negative, and unfunded without auto-drawing the HELOC',
  [...seen].join(', '));
ok(!seen.has('combination') && !seen.has('belowBuffer'),
  'combination is proved on fixtures above once Q25 keeps Amanda at $0; belowBuffer stays on fixtures');

console.log('\n=== 12b. the band and the source card cannot contradict each other ===');
/* The blocking review's counterexample, rendered. Both surfaces read one
 * funding result, so the test is not "each is individually right" — it is that
 * the two sentences on screen together cannot assert opposite things. */
{
  const needed = rankTrap.gap.amount;
  const [, bandHtml] = movedBand({ adv: rankTrap, sim: rankTrap.sim, weeklyVariable: null });
  const cards = rankTrap.funding.sources
    .map(s => ({ id: s.id, html: FUND_VERDICT[s.verdict].text(s, needed) }));

  const bandSaysNoneCover = /no single source covers it/.test(bandHtml);
  const covering = cards.find(c => /Covers the whole/.test(c.html)) || null;
  const aCardSaysItCovers = !!covering;

  ok(aCardSaysItCovers,
    'the rank-2 card does say it covers the whole gap',
    covering ? `${covering.id}: ${flat(covering.html)}` : 'no card claims coverage');
  ok(!bandSaysNoneCover,
    'so the band above it must not say no single source covers it',
    flat(bandHtml).slice(0, 90));
  ok(!(bandSaysNoneCover && aCardSaysItCovers),
    'the two surfaces cannot contradict each other on one funding result');
  ok(/the plan draws on more than one source/.test(bandHtml),
    'and the band states what the allocation actually proves',
    flat(bandHtml).slice(0, 100));

  // Live sources no longer auto-draw the HELOC: Amanda is $0 available, so a
  // mid-sized gap is unfunded. The HELOC cover card stays off.
  const real = published({ targetBuffer: COMBINE_BUF, weeklyVariable: null });
  const [, realBand] = movedBand(real);
  ok(!/Covers the whole/.test(movedCards(real)),
    'the published mid-sized gap has no HELOC cover card');
  ok(!/no single source covers it/.test(realBand),
    'and the band does not claim no single source covers it');
}

console.log('\n=== 13. the real page, booted ===');
/* Everything above proves the engine and inspects the page as text. This runs
 * the page: `public/app.js`, `public/forecast.js` and `public/plan.js`, in the
 * order `index.html` loads them, against a stub DOM, booted through
 * `App.boot()` on the real `data.json`. A proof that stops at the wording map
 * cannot see a template reading a field the engine stopped returning — that
 * renders `undefined` at the household while every check above still passes. */
function bootPage() {
  const els = new Map();
  const makeEl = id => {
    const el = {
      id, textContent: '', value: '', placeholder: '', checked: false, hidden: false,
      className: '', style: {}, children: [], listeners: {}, attributes: {},
      addEventListener(kind, fn) { (this.listeners[kind] = this.listeners[kind] || []).push(fn); },
      setAttribute(k, v) { this.attributes[k] = v; },
      removeAttribute(k) { delete this.attributes[k]; },
      appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
      append(...children) { for (const child of children) this.appendChild(child); },
      remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; } },
      insertAdjacentHTML(_, html) { this.innerHTML = String(html); },
      querySelectorAll: () => [],
    };
    let html = '';
    Object.defineProperty(el, 'innerHTML', {
      get: () => html, set(v) { html = String(v); el.children = []; },
    });
    return el;
  };
  const get = id => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  const doc = {
    getElementById: get,
    createElement: () => makeEl('created'),
    createElementNS: () => makeEl('svg'),
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: makeEl('html'),
    body: { scrollHeight: 0 },
  };
  const periods = JSON.parse(read('public/periods.json'));
  const sandbox = {
    document: doc,
    // Empty readable pending store; no change to the old unavailable knob/theme store.
    localStorage: { getItem(key) { if (key === 'atlas-settlement-pending-v1') return null; throw Error('synthetic non-marker storage unavailable'); },
      setItem() { throw Error('storage write forbidden'); }, removeItem() { throw Error('storage removal forbidden'); } },
    addEventListener() {},
    matchMedia: () => ({ addEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame() {},
    innerWidth: 1200, innerHeight: 800, scrollY: 0,
    console,
    // The two files index.html's boot actually fetches.
    fetch: url => Promise.resolve({ status: 200, ok: true,
      json: () => (String(url).includes('periods') ? periods : data) }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  Object.assign(sandbox, { AbortController, setTimeout, clearTimeout });
  vm.createContext(sandbox);
  for (const file of ['public/app.js', 'public/forecast.js', 'public/budget-surface.js', 'public/plan.js']) {
    vm.runInContext(read(file), sandbox, { filename: file });
  }
  return { get, sandbox };
}

{
  const page = bootPage();
  // App.boot resolves its fetches and renders on the microtask queue; a
  // macrotask turn runs after all of them have drained.
  setTimeout(() => {
    ok(/data-budget-surface=/.test(page.get('operating-surface-body').innerHTML),
      'the active Budget renderer completes during boot');
    const bandEl = page.get('status-band');
    const fundEl = page.get('funding-options');
    const inputs = published({ targetBuffer: plan.defaults.targetBuffer, weeklyVariable: null });
    const [expectCls, expectHtml] = movedBand(inputs);

    ok(bandEl.className === expectCls,
      'the booted page sets the tone class the engine\'s verdict maps to',
      `${bandEl.className} vs ${expectCls}`);
    ok(flat(bandEl.innerHTML) === flat(expectHtml),
      'and publishes the verdict sentence, rendered end to end',
      flat(bandEl.innerHTML) === flat(expectHtml)
        ? flat(bandEl.innerHTML).slice(0, 72) + '…'
        : `\n      page:     ${flat(bandEl.innerHTML)}\n      expected: ${flat(expectHtml)}`);
    ok(!/undefined|NaN|\[object/.test(bandEl.innerHTML),
      'with no undefined, NaN or [object Object] in it');

    ok(flat(fundEl.innerHTML) === flat(movedCards(inputs)),
      'the booted page publishes the four funding-source cards');
    ok(!/undefined|NaN|\[object/.test(fundEl.innerHTML),
      'with no undefined, NaN or [object Object] in them either');
    ok((fundEl.innerHTML.match(/class="fund /g) || []).length === (inputs.adv.gap ? 4 : 0),
      inputs.adv.gap
        ? 'one card per declared source'
        : 'no funding cards when the published default has no opening gap',
      String((fundEl.innerHTML.match(/class="fund /g) || []).length));

    // Print-only data-plan-status hook: the engine's verdict id on every paint,
    // 'unavailable' on the live-unavailable path; text and class unchanged.
    ok(bandEl.attributes['data-plan-status'] === movedBand(inputs)[2],
      'the booted band carries data-plan-status = the engine verdict id', bandEl.attributes['data-plan-status']);
    const F2 = page.sandbox.Forecast, realStatus = F2.planStatus, periods = JSON.parse(read('public/periods.json'));
    const statuses = { onPlan, belowBuffer, negative, gap: plain, infeasible, unfunded, overrideBreach: breach, combination: combo,
      unavailable: { id: 'unavailable', status: 'unavailable', reason: 'Income is uncertain.' } };
    const paint = (s, liveDown) => { F2.planStatus = () => s;
      page.sandbox.renderPlan(liveDown ? { ...data, liveOverlay: { ...(data.liveOverlay || {}), operatingPlan: 'unavailable', operatingPlanNote: 'Stale opening.' } } : data, periods); };
    for (const id of ['infeasible', 'onPlan', 'belowBuffer', 'negative', 'gap', 'unfunded', 'overrideBreach', 'combination', 'unavailable']) {
      const s = statuses[id]; ok(s.id === id, 'fixture verdict ' + id);
      paint(s);
      ok(bandEl.attributes['data-plan-status'] === id && bandEl.className === 'statusband ' + STATUS_BAND[id].tone
        && flat(bandEl.innerHTML) === flat(STATUS_BAND[id].text(s, plan)),
        `data-plan-status="${id}" with the band class and text unchanged`, bandEl.attributes['data-plan-status']);
      if (id !== 'infeasible') continue;
      // Live-unavailable repaint over 'infeasible', then 'onPlan' over it: no stale id either way.
      paint(s, true);
      ok(bandEl.attributes['data-plan-status'] === 'unavailable' && bandEl.className === 'statusband warn'
        && flat(bandEl.innerHTML) === '<b>Current plan unavailable.</b> Stale opening.',
        'live-unavailable repaint sets data-plan-status="unavailable" (no stale infeasible)', bandEl.attributes['data-plan-status']);
    }
    F2.planStatus = realStatus;

    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
  }, 0);
}
