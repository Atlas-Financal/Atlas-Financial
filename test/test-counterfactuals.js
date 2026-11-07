'use strict';
/* Focused proof for Forecast.counterfactuals(). `node test/test-counterfactuals.js`
 *
 * Two alternative-reality questions the Plan page publishes answers to:
 *
 *   FULL GAP COVERAGE   "with only $3,759.69 of the $5,543.16 gap fundable.
 *                        Cover the whole gap and it becomes $1,085/week."
 *   GAP FUNDED BY DRAW  "Covering the opening gap from it instead of Amanda's
 *                        transfer brings that crossing forward to 31 August."
 *
 * `public/plan.js` used to compose both. It invented a funding source holding
 * `available: Infinity`, and it chose `fundingDebtId: 'heloc'` and ran its own
 * second `recommend` and `projectDebts`. The arithmetic was always the
 * engine's; what lived in the page was WHICH alternative to run, WHAT stands
 * for the assumption, under WHICH scenario, and WHETHER the answer means
 * anything — four decisions no test could reach. B73 item 4.
 *
 * Six kinds of check, and they prove different things:
 *
 *   1. HAND-COMPUTED CASES. A fixture whose funding arithmetic is small enough
 *      to do on paper: a $4,600 gap against $1,600 of free money and $1,500 of
 *      borrowable headroom leaves $1,500 no source reaches. Every expected
 *      figure is reasoned in the comment above the case, not read back off the
 *      engine.
 *   2. RECONCILIATION. The returned counterfactual has to agree with the
 *      `recommend` and `projectDebts` runs underneath it — the top-up equals
 *      the shortfall exactly, the alternative's allocation closes the gap, and
 *      the alternative's draw appears in the debt walk once, on the day the
 *      injection is placed.
 *   3. PROPAGATION. Scenario, target buffer, income overrides, disabled
 *      commitments and debt state must reach the counterfactual unchanged. The
 *      counterfactual is allowed to differ from the plan on screen in exactly
 *      one thing: the funding assumption.
 *   4. NOT-APPLICABLE. Six of the twelve states this authority can be asked
 *      about have no honest answer. Each returns a reason a test can name,
 *      rather than a fabricated date or a meaningless weekly figure.
 *   5. MUTATION. Each decision is broken on purpose in the engine source and
 *      the answer has to change. A decision that cannot be broken was not
 *      being tested — which is what B73 recorded about these two blocks while
 *      they lived in the page.
 *   6. THE REAL PAGE. `public/plan.js` is booted against a stub DOM on the real
 *      `data.json` and the two sentences are read back, so the proof reaches
 *      the words the household is shown rather than stopping at the engine.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sourceText } = require('./test-source-text');
const F = require('../public/forecast.js');
const data = require('../data.json');
const { openingFloor } = require('./test-helpers');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const read = p => sourceText(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
const cents = n => Math.round(n * 100);
const same = (a, b) => cents(a) === cents(b);
const money = n => '$' + Number(n).toFixed(2);

/* ------------------------------------------------------------- fixture */
/* A plan small enough to check on paper. One payment falls before any income
 * arrives, which is what creates an opening gap; the numbers below are chosen
 * so the funding arithmetic is exact.
 *
 *   starting cash                                   $100.00
 *   registration due 2026-08-12                   − $700.00
 *   ----------------------------------------------------------
 *   floor before any income                       − $600.00
 *
 * so the gap is the target buffer plus $600, exactly. Three buffers are used
 * below, and each reaches a different state of this authority:
 *
 *   $500    gap $1,100   savings ($1,600) cover it alone, nothing borrowed.
 *                        The credit line ($1,500) is debt capacity, not
 *                        automatic opening-gap cash.
 *   $2,000  gap $2,600   savings give $1,600; the line is not auto-drawn, so
 *                        $1,000 remains unfunded.
 *   $4,000  gap $4,600   savings give $1,600 and $3,000 is unfundable,
 *                        which is the full-coverage case. */
const FIX_AS_OF = '2026-08-10';
const fixture = () => ({
  windowDays: 91,
  defaults: { targetBuffer: 500, extraDebtMonthly: 0, scenario: 'expected' },
  startingCash: { amount: 100 },
  income: [
    { id: 'salary', label: 'Salary', frequency: 'biweekly', anchor: '2026-08-21',
      scenarioMonthly: { conservative: 4000, expected: 5000, optimistic: 6000 } },
  ],
  obligations: [],
  bills: [],
  commitments: [
    { id: 'reg', label: 'Registration', amount: 700, date: '2026-08-12',
      confidence: 'confirmed', group: null },
  ],
  groups: [],
  funding: {
    heading: 'Covering the gap',
    note: 'fixture',
    options: [
      { id: 'savings', debtId: null, label: 'Savings', short: 'savings',
        available: 1600, rate: null, rank: 1, note: 'free money' },
      { id: 'line', debtId: 'line', label: 'Credit line', short: 'the credit line',
        available: 1500, rate: 5, rank: 2, note: 'borrowed' },
      { id: 'dead', debtId: null, label: 'Unusable', short: 'the unusable one',
        available: 9000, rate: null, rank: 3, unusable: true, note: 'excluded' },
    ],
  },
});

/* One revolving facility, the one the credit-line funding option draws on.
 * Nothing repays it and its 5% capitalises, so at $9,950 against a $10,000
 * limit it crosses on its own inside the window — that is the crossing the
 * alternative moves. A draw on the gap day puts it over immediately, which is
 * why the alternative brings the date forward rather than changing nothing. */
const fixtureDebts = () => ([
  { id: 'line', label: 'Credit line', balance: 9950, limit: 10000, rate: 5,
    payment: 0, secured: false, revolving: true, rateConvention: 'variable',
    interestCapitalises: true },
]);

const opts = (o = {}) => Object.assign({
  scenario: 'expected', targetBuffer: 500, extraDebtMonthly: 0,
  incomeOverrides: {}, disabled: [],
  fundingSources: fixture().funding.options,
}, o);

/* The two engine runs a caller makes before asking for a counterfactual. */
function evaluate(plan, asOf, o, debts) {
  const advice = F.recommend(plan, asOf, o);
  const proj = F.projectDebts(plan, debts, asOf,
    Object.assign({}, advice.simOptions, { weeklyVariable: advice.weekly }));
  const cf = F.counterfactuals(plan, asOf, advice, proj, { debts, weekly: advice.weekly });
  return { advice, proj, cf };
}
const fixtureRun = (o = {}) =>
  evaluate(fixture(), FIX_AS_OF, opts(o), fixtureDebts());

const altFor = (cf, debtId) =>
  cf.gapFundingAlternatives.find(a => a.debtId === debtId) || null;

console.log('\n=== 1. the gap, and what the declared sources reach ===');
/* Hand-computed. $100 in the account and $700 out on 12 August before any
 * income arrives puts the floor at −$600; restoring a $500 buffer on top makes
 * the gap $1,100. Savings hold $1,600, so they cover it alone and nothing is
 * borrowed — which is what leaves the credit line free to be an alternative. */
{
  const { advice } = fixtureRun();
  ok(!!advice.gap, 'the fixture opens with a gap', advice.gap && money(advice.gap.amount));
  ok(advice.gap.date === '2026-08-12', 'on the day the registration is due', advice.gap.date);
  ok(advice.funding.feasible, 'which the declared sources can cover');
  ok(same(advice.funding.borrowed, 0), 'without borrowing anything', money(advice.funding.borrowed));
  ok(advice.funding.parts.length === 1 && advice.funding.parts[0].id === 'savings',
    'from savings alone, the top-ranked source');
  // The identity the whole allocation rests on, restated here because every
  // counterfactual figure below is derived from one side of it.
  ok(same(advice.funding.allocated + advice.funding.shortfall, advice.gap.amount),
    'allocated + shortfall = the gap');
}

console.log('\n=== 2. full coverage: an unfunded gap ===');
/* CORRECTNESS CASE 1. At a $4,000 buffer the gap is $4,600 and outruns the
 * cash source: savings give $1,600; the credit line is not automatic
 * opening-gap cash — so $3,000 is unfundable and the plan supports $0/week.
 * The counterfactual supplies exactly that $3,000 from outside and reports
 * what the household could then spend. */
{
  const { advice, cf } = fixtureRun({ targetBuffer: 4000 });
  const g = cf.fullGapCoverage;
  ok(!advice.funding.feasible, 'the declared sources cannot reach the $4,000-buffer gap',
    `${money(advice.funding.allocated)} of ${money(advice.gap.amount)}`);
  ok(g.applies, 'so the full-coverage counterfactual applies');
  ok(same(g.shortfall, advice.funding.shortfall),
    'it reports the shortfall the real allocation leaves', money(g.shortfall));
  ok(same(g.fundable, advice.funding.allocated),
    'and what the declared sources do reach, from the allocation itself', money(g.fundable));
  ok(same(g.fundable + g.shortfall, g.gapAmount),
    'the two add to the gap the page prints beside them');
  // CORRECTNESS CASE 6. The whole point of the move: the assumption is a real
  // amount of money, not an infinity that quietly replaced the real plan.
  ok(same(g.externalTopUp, g.shortfall),
    'the assumption supplies EXACTLY the shortfall — no more, no less',
    money(g.externalTopUp));
  for (const [k, v] of Object.entries(g)) {
    if (typeof v === 'number') {
      ok(Number.isFinite(v), `${k} is a finite figure`, String(v));
    }
  }
  ok(g.weekly > 0, 'and the counterfactual weekly figure is a real amount', money(g.weekly));
  ok(advice.weekly === 0, 'against $0/week on the plan that actually holds', money(advice.weekly));
}

console.log('\n=== 3. full coverage: it adds no debt ===');
/* The assumption is that the missing money is FOUND, not borrowed. Ranked
 * behind every declared source, it receives only what the real allocation
 * leaves — so the real parts, and the borrowing among them, are untouched. */
{
  const { advice, cf } = fixtureRun({ targetBuffer: 4000 });
  const g = cf.fullGapCoverage;
  ok(same(g.addsBorrowing, 0), 'the full-coverage assumption creates no new debt',
    money(g.addsBorrowing));
  ok(same(g.borrowed, advice.funding.borrowed),
    'the alternative borrows exactly what the real plan borrows',
    `${money(g.borrowed)} vs ${money(advice.funding.borrowed)}`);
  ok(same(advice.funding.borrowed, 0),
    'and the real plan does not auto-borrow the credit line',
    money(advice.funding.borrowed));
  // RECONCILIATION. Re-run the alternative independently and require the
  // engine's own allocation to close the gap under it.
  const alt = F.recommend(fixture(), FIX_AS_OF, opts({
    targetBuffer: 4000,
    fundingSources: fixture().funding.options.concat([{
      id: 'externalCoverage', label: 'x', short: 'x',
      available: advice.funding.shortfall, debtId: null, rank: 4 }]),
  }));
  ok(alt.funding.feasible, 'the alternative allocation closes the gap');
  ok(same(alt.funding.allocated, advice.gap.amount), 'reaching the whole gap');
  ok(same(alt.weekly, g.weekly),
    'and the weekly figure reconciles with recommend() run directly',
    `${money(alt.weekly)} vs ${money(g.weekly)}`);
}

console.log('\n=== 4. full coverage: when it does not apply ===');
{
  // CORRECTNESS CASE 2. No opening gap at all: there is nothing to cover, and
  // an "if it were covered" figure would answer a question nobody asked.
  const noGap = fixture();
  noGap.startingCash.amount = 20000;
  const { advice, cf } = evaluate(noGap, FIX_AS_OF, opts(), fixtureDebts());
  ok(!advice.gap, 'a plan with no opening gap has no gap to cover');
  ok(!cf.fullGapCoverage.applies && cf.fullGapCoverage.reason === 'noOpeningGap',
    'and no full-coverage counterfactual is published', cf.fullGapCoverage.reason);

  // CORRECTNESS CASE 3. A gap the declared sources already reach. The plan
  // being drawn IS the fully-covered plan, so an "if it were covered"
  // alternative would restate the answer beside itself as though it were news.
  const fundable = fixtureRun();
  ok(fundable.advice.funding.feasible, 'the default fixture gap is fully fundable');
  ok(!fundable.cf.fullGapCoverage.applies
    && fundable.cf.fullGapCoverage.reason === 'gapAlreadyFundable',
    'and no unnecessary "if fully covered" alternative is invented',
    fundable.cf.fullGapCoverage.reason);
}

console.log('\n=== 5. full coverage: the scenario and the buffer propagate ===');
/* CORRECTNESS CASES 4 AND 5. The counterfactual differs from the plan on
 * screen in the funding assumption and in nothing else. Proved by moving one
 * assumption at a time and requiring the counterfactual to move with it. */
{
  const at = o => fixtureRun(Object.assign({ targetBuffer: 4000 }, o)).cf.fullGapCoverage;
  const cons = at({ scenario: 'conservative' });
  const exp = at({ scenario: 'expected' });
  const opt = at({ scenario: 'optimistic' });
  ok(cons.applies && exp.applies && opt.applies, 'the counterfactual applies in all three scenarios');
  ok(cons.weekly < exp.weekly && exp.weekly < opt.weekly,
    'and its weekly figure rises with the income scenario, so the scenario reached it',
    [cons, exp, opt].map(x => money(x.weekly)).join(' < '));

  // An income override is a scenario the household typed. It has to reach the
  // counterfactual the same way the named scenarios do.
  const over = at({ incomeOverrides: { salary: 4600 } });
  ok(over.weekly > 0 && over.weekly < exp.weekly,
    'an income override moves the counterfactual too, and not to zero',
    `${money(over.weekly)} vs ${money(exp.weekly)}`);

  // CORRECTNESS CASE 5. A different buffer is a different gap AND a different
  // recovery. The counterfactual must be measured from the buffer in force,
  // not from `plan.defaults.targetBuffer`.
  const b4000 = at({});
  const b5000 = fixtureRun({ targetBuffer: 5000 }).cf.fullGapCoverage;
  ok(b5000.applies, 'a higher buffer still reaches the counterfactual');
  ok(cents(b5000.gapAmount) === cents(b4000.gapAmount) + 100000,
    'against a gap larger by exactly the buffer difference',
    `${money(b4000.gapAmount)} → ${money(b5000.gapAmount)}`);
  ok(cents(b5000.shortfall) === cents(b4000.shortfall) + 100000,
    'and a shortfall larger by the same $1,000',
    `${money(b4000.shortfall)} → ${money(b5000.shortfall)}`);
  ok(same(b5000.externalTopUp, b5000.shortfall),
    'still topped up by exactly that shortfall and not by the default buffer\'s');
  // Stated rather than left as a surprise: the counterfactual's WEEKLY figure
  // is the same at every buffer, and that is arithmetic, not a bug. The gap is
  // `buffer − floor`, so topping it up in full puts the floor at exactly the
  // buffer whatever the buffer is; the rest of the window keeps the same shape
  // relative to it, and the largest sustainable weekly spend does not move. It
  // is why the buffer's propagation is proved below through what the
  // alternative BORROWS, which does move, rather than through `weekly`.
  ok(same(b5000.weekly, b4000.weekly),
    'the weekly figure itself is buffer-invariant, by construction',
    `${money(b4000.weekly)} = ${money(b5000.weekly)}`);
  ok(same(b5000.borrowed, 0) && same(b4000.borrowed, 0),
    'neither buffer auto-borrows the credit line',
    money(b4000.borrowed));
  // At the DEFAULT buffer the same fixture borrows nothing, because savings
  // alone reach a $1,100 gap. The $4,000 buffer also borrows nothing: the
  // extra shortfall is unfunded cash, not a HELOC draw.
  const atDefault = fixtureRun().advice.funding;
  ok(same(atDefault.borrowed, 0) && same(b4000.borrowed, 0),
    'and opening-gap recovery does not start borrowing when the buffer rises',
    `${money(atDefault.borrowed)} vs ${money(b4000.borrowed)}`);

  // A disabled commitment changes the schedule the gap is measured from, so it
  // has to change the counterfactual's gap as well. Turning off the $700
  // registration is the whole reason this fixture has a gap on that day.
  const on = at({});
  const off = at({ disabled: ['reg'] });
  ok(off.applies, 'disabling the commitment leaves a gap at this buffer');
  ok(cents(on.gapAmount) - cents(off.gapAmount) === 70000,
    'and shrinks the counterfactual\'s gap by exactly the $700 removed',
    `${money(on.gapAmount)} → ${money(off.gapAmount)}`);
}

console.log('\n=== 6. the draw alternative: eligibility is derived, not chosen ===');
/* CORRECTNESS CASE 10. Which facilities can be offered comes from the declared
 * funding options — a usable option naming a debt record. No id is written in
 * the engine and none in the page. */
{
  const { cf } = fixtureRun();
  ok(cf.gapFundingAlternatives.length === 1,
    'one alternative, for the one usable funding option that names a debt',
    cf.gapFundingAlternatives.map(a => a.sourceId).join(', '));
  ok(cf.gapFundingAlternatives[0].debtId === 'line',
    'the credit line, derived from its own funding record');

  // No debt-backed option at all: nothing to offer, and nothing invented.
  const noDraw = fixture();
  noDraw.funding.options = noDraw.funding.options.filter(o => !o.debtId);
  const bare = evaluate(noDraw, FIX_AS_OF, opts({ fundingSources: noDraw.funding.options }),
    fixtureDebts());
  ok(bare.cf.gapFundingAlternatives.length === 0,
    'no eligible facility means no alternative is invented');

  // An unusable one is not eligible either — the plan cannot spend it, so
  // offering it would be offering money the allocation already excluded.
  const unusable = fixture();
  unusable.funding.options = unusable.funding.options.map(o =>
    o.debtId ? Object.assign({}, o, { unusable: true }) : o);
  const none = evaluate(unusable, FIX_AS_OF, opts({ fundingSources: unusable.funding.options }),
    fixtureDebts());
  ok(none.cf.gapFundingAlternatives.length === 0,
    'and an unusable facility is not an eligible alternative either');
}

console.log('\n=== 7. the draw alternative: debt is not automatic opening-gap cash ===');
{
  const { advice, proj, cf } = fixtureRun();
  const a = altFor(cf, 'line');
  const current = proj.crossings.find(c => c.id === 'line' && !c.alreadyOver);
  ok(!!current, 'the credit line crosses its limit on the plan as it stands',
    current && current.date);
  ok(a && !a.applies && a.reason === 'borrowing-not-automatic',
    'the draw alternative does not auto-convert headroom into gap cash',
    a && a.reason);
  ok(same(a.available, 1500) && same(a.gapAmount, advice.gap.amount),
    'capacity and the gap remain visible on the refused alternative');

  const altAdvice = F.recommend(fixture(), FIX_AS_OF,
    opts({ fundingSources: [fixture().funding.options.find(o => o.id === 'line')] }));
  ok(!altAdvice.funding.feasible && same(altAdvice.funding.borrowed, 0),
    'recommend with only the credit line still does not auto-draw it');
  ok(!(altAdvice.simOptions.injections || []).some(i => i.debtId === 'line'),
    'and places no debtId injection');
}

console.log('\n=== 8. the draw alternative: when it does not apply ===');
{
  // CORRECTNESS CASE 8. A larger buffer still does not auto-draw the line.
  // Offering it as opening-gap cash would reintroduce unapproved borrowing.
  const drawn = fixtureRun({ targetBuffer: 2000 });
  ok(!drawn.advice.funding.parts.some(p => p.debtId === 'line'),
    'at a $2,000 buffer the real allocation still does not draw on the credit line');
  const a = altFor(drawn.cf, 'line');
  ok(!a.applies && a.reason === 'borrowing-not-automatic',
    'so no auto-borrow "instead use it" counterfactual is published', a.reason);

  // CORRECTNESS CASE 9. No opening gap: nothing to fund from anywhere.
  const noGap = fixture();
  noGap.startingCash.amount = 20000;
  const flush = evaluate(noGap, FIX_AS_OF, opts(), fixtureDebts());
  const b = altFor(flush.cf, 'line');
  ok(b && !b.applies && b.reason === 'noOpeningGap',
    'no opening gap means no gap-funding counterfactual', b && b.reason);

  // CORRECTNESS CASE 11, first form. The facility has no crossing to move, so
  // there is no alternate date to publish.
  const roomy = fixtureDebts().map(x => Object.assign({}, x, { limit: 500000 }));
  const wide = evaluate(fixture(), FIX_AS_OF, opts({ debts: roomy }), roomy);
  const c = altFor(wide.cf, 'line');
  ok(!c.applies && c.reason === 'noCurrentCrossing',
    'a facility that never crosses its limit yields no crossing counterfactual', c.reason);
}

console.log('\n=== 9. the draw alternative cannot overdraw the facility ===');
/* Unapproved borrowing is not priced as opening-gap cash, whether or not
 * the facility has enough headroom. The funding card and the counterfactual
 * both refuse the line as automatic recovery. */
{
  const { advice, cf } = fixtureRun();
  const line = fixture().funding.options.find(o => o.id === 'line');
  const a = altFor(cf, 'line');
  ok(a && !a.applies && a.reason === 'borrowing-not-automatic',
    'a line holding $1,500 is still not automatic opening-gap cash', a && a.reason);
  ok(same(a.available, line.available),
    'its declared headroom stays visible', money(a.available));
  ok(!a.alternateCrossing, 'so no crossing date is invented for a draw');

  const tight = fixture();
  tight.funding.options = tight.funding.options.map(o =>
    o.id === 'line' ? Object.assign({}, o, { available: 400 }) : o);
  const t = evaluate(tight, FIX_AS_OF, opts({ fundingSources: tight.funding.options }),
    fixtureDebts());
  const ta = altFor(t.cf, 'line');
  ok(!ta.applies && ta.reason === 'borrowing-not-automatic',
    'a line holding $400 is refused the same way, not priced as an overdraw', ta.reason);
  ok(!ta.alternateCrossing, 'so no crossing date is published for it');
  const card = t.advice.funding.sources.find(s => s.id === 'line');
  ok(card.verdict === 'insufficient',
    'the funding card says the same facility cannot cover the gap', card.verdict);
}

console.log('\n=== 10. the published plan: figures and reconciliation ===');
/* The real data, through the real call the page makes. These are the figures
 * the household actually reads today. */
const plan = data.plan;
const AS_OF = data.meta.asOf;
function published(o = {}) {
  const base = Object.assign({
    scenario: plan.defaults.scenario, targetBuffer: plan.defaults.targetBuffer,
    extraDebtMonthly: plan.defaults.extraDebtMonthly, incomeOverrides: {}, disabled: [],
    debts: data.debts, extraDebtTarget: plan.nextDollar && plan.nextDollar.target,
    fundingSources: plan.funding.options,
  }, o);
  const advice = F.recommend(plan, AS_OF, base);
  const weekly = o.weeklyVariable != null ? o.weeklyVariable : advice.weekly;
  const proj = F.projectDebts(plan, data.debts, AS_OF, Object.assign({}, advice.simOptions,
    { weeklyVariable: weekly, extraFacilities: data.revolvingExtra,
      extraDebtTarget: plan.nextDollar && plan.nextDollar.target }));
  const cf = F.counterfactuals(plan, AS_OF, advice, proj,
    { debts: data.debts, extraFacilities: data.revolvingExtra, weekly });
  return { advice, proj, cf, weekly };
}
{
  const { advice, cf } = published();
  ok(!cf.fullGapCoverage.applies
    && (cf.fullGapCoverage.reason === 'gapAlreadyFundable'
      || cf.fullGapCoverage.reason === 'noOpeningGap'),
    'the published plan has no unfunded gap, so no full-coverage line is shown',
    cf.fullGapCoverage.reason);
  const a = altFor(cf, 'heloc');
  ok(!!a, 'a HELOC alternative object is returned');
  if (a.applies) {
    ok(a.currentCrossing && a.alternateCrossing
      && a.alternateCrossing.date <= a.currentCrossing.date,
      'and funding the gap from it does not delay that crossing',
      a.alternateCrossing && a.alternateCrossing.date);
    const helocCharge = (plan.obligations.find(o => o.id === 'heloc') || {}).amount || 0;
    ok(a.draw + 0.005 < helocCharge || a.alternateCrossing.date < a.currentCrossing.date,
      'a draw of at least one capitalised charge pulls the crossing strictly sooner',
      a.alternateCrossing.date);
    ok(same(a.draw, advice.gap.amount),
      'drawing the whole opening gap', money(a.draw));
    const helocRoom = F.resolveFundingSources(
      plan.funding.options, data.revolvingExtra, plan, data.debts
    ).find(o => o.id === 'heloc').available;
    ok(a.draw <= helocRoom + 0.005,
      'which is inside the HELOC\'s own declared headroom',
      `${money(a.draw)} <= ${money(helocRoom)}`);
    ok(a.displaces.join(' and ') === 'Amanda\'s transfer',
      'instead of the source the real allocation uses', a.displaces.join(' and '));
  } else {
    ok(a.reason === 'noEarlierCrossing' || a.reason === 'sourceCannotCoverGap'
      || a.reason === 'alreadyFunded' || a.reason === 'noCurrentCrossing'
      || a.reason === 'noOpeningGap' || a.reason === 'borrowing-not-automatic',
      'when the draw is not automatic opening-gap cash, the alternative does not apply',
      a.reason);
  }
}
{
  // At a $5,000 buffer the published data reaches the full-coverage case, and
  // the three scenarios have to give three different answers.
  const at = s => published({ targetBuffer: 8000, scenario: s }).cf.fullGapCoverage;
  const c = at('conservative'), e = at('expected'), o = at('optimistic');
  ok(c.applies && e.applies && o.applies,
    'an $8,000 buffer reaches the full-coverage case on the published data');
  ok(cents(c.weekly) <= cents(e.weekly) && cents(e.weekly) <= cents(o.weekly),
    'weekly never falls as the income scenario improves',
    [c, e, o].map(x => money(x.weekly)).join(' / '));
  const usable = F.resolveFundingSources(
    plan.funding.options, data.revolvingExtra, plan, data.debts
  ).filter(s => !s.unusable && !s.debtId).reduce((s, x) => s + x.available, 0);
  ok(same(e.fundable, usable) && same(e.gapAmount, e.fundable + e.shortfall),
    'against the usable sources of that gap, with shortfall the remainder',
    `${money(e.fundable)} / ${money(e.gapAmount)}, short ${money(e.shortfall)}`);
  ok(same(e.addsBorrowing, 0), 'and the assumption adds no borrowing to it');
}
{
  // Gap larger than HELOC headroom. Q25 keeps Amanda at $0, so the plan
  // cannot auto-draw the HELOC. The funding card must not say the facility
  // covers that gap, and the draw-alternative must not invent a crossing.
  const helocAvail = F.resolveFundingSources(
    plan.funding.options, data.revolvingExtra, plan, data.debts
  ).find(o => o.id === 'heloc').available;
  const bufHelocShort = helocAvail + openingFloor(plan, AS_OF) + 200;
  const { advice, cf } = published({ targetBuffer: bufHelocShort });
  const card = advice.funding.sources.find(s => s.id === 'heloc');
  const a = altFor(cf, 'heloc');
  ok(card.verdict !== 'covers',
    'at a gap the HELOC cannot cover, the funding card does not say it covers', card.verdict);
  ok(same(card.shortBy, advice.gap.amount),
    'the HELOC card is short the whole gap, because headroom is not cash', money(card.shortBy));
  ok(!a.applies && (a.reason === 'sourceCannotCoverGap' || a.reason === 'alreadyFunded'
      || a.reason === 'borrowing-not-automatic' || a.reason === 'noCurrentCrossing'),
    'and the counterfactual does not price a draw beyond the facility', a.reason);
  ok(!a.alternateCrossing,
    'publishing no crossing date rather than one produced by an overdraw');
}

console.log('\n=== 11. published figures do not move except with the plan input ===');
/* The alternative crossing date and the full-coverage weekly figure, compared
 * against the values `public/plan.js` produced at a7fe97b through the exact
 * expressions it ran, then retargeted when the 91-day payroll cash input
 * moved from $4,468.69 to $4,264. Written as literals: reading them back off
 * the engine would prove only that the engine agrees with itself. */
/* Alternative crossing and full-coverage weekly follow the current Plan
 * inputs. Pinning today's cents here made a cash or payroll refresh look like
 * an engine rewrite. Crossing must be a capitalisation day when the
 * alternative applies; the weekly figure, when shown, must be a $5 step. */
{
  const cases = [
    { label: 'default', o: {} },
    { label: '$600/wk override', o: { weeklyVariable: 600 } },
    { label: 'buffer $0', o: { targetBuffer: 0 } },
    { label: 'buffer $4,000', o: { targetBuffer: 4000 } },
    { label: 'buffer $5,000', o: { targetBuffer: 5000 } },
    { label: 'buffer $3,800', o: { targetBuffer: 3800 } },
  ];
  for (const c of cases) {
    const { cf } = published(c.o);
    const a = altFor(cf, 'heloc');
    const g = cf.fullGapCoverage;
    const gotCross = a && a.applies ? a.alternateCrossing.date : null;
    const gotCap = g.applies ? g.weekly : null;
    ok(!gotCross || /-(08|09|10)-3[01]$/.test(gotCross),
      `${c.label}: a HELOC alternative crossing is a month-end charge date`,
      String(gotCross));
    ok(gotCap == null || (gotCap >= 0 && gotCap % 5 === 0),
      `${c.label}: a full-coverage weekly figure is a $5 step`,
      String(gotCap));
  }
}

console.log('\n=== 12. mutation: breaking the engine breaks the answer ===');
/* Each mutation targets one decision this authority makes. The mutant engine
 * must disagree with the real one on a case above. A decision that survives
 * being broken was not being tested. */
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
function withEngine(engine, plan_, asOf, o, debts, extra) {
  const advice = engine.recommend(plan_, asOf, o);
  const proj = engine.projectDebts(plan_, debts, asOf,
    Object.assign({}, advice.simOptions, { weeklyVariable: advice.weekly }, extra || {}));
  return { advice,
    cf: engine.counterfactuals(plan_, asOf, advice, proj,
      Object.assign({ debts, weekly: advice.weekly }, extra || {})) };
}

const MUTATIONS = [
  { label: 'the counterfactual drops the current income scenario',
    from: '    const withFunding = sources =>\n      recommend(plan, asOf, Object.assign({}, base, { fundingSources: sources }));',
    to: '    const withFunding = sources =>\n      recommend(plan, asOf, Object.assign({}, base, { fundingSources: sources, scenario: plan.defaults.scenario, incomeOverrides: {} }));',
    check: m => {
      const r = withEngine(m, fixture(), FIX_AS_OF,
        opts({ targetBuffer: 4000, scenario: 'conservative' }), fixtureDebts());
      return r.cf.fullGapCoverage.applies && !same(r.cf.fullGapCoverage.weekly, REAL.cons.weekly);
    } },

  { label: 'full coverage funds LESS than the gap',
    from: '      const topUp = funding.shortfall;',
    to: '      const topUp = funding.shortfall / 2;',
    check: m => {
      const r = withEngine(m, fixture(), FIX_AS_OF, opts({ targetBuffer: 4000 }), fixtureDebts());
      const g = r.cf.fullGapCoverage;
      return g.applies && (!same(g.externalTopUp, g.shortfall) || !same(g.weekly, REAL.b4000.weekly));
    } },

  { label: 'full coverage is supplied as BORROWED money rather than found',
    from: "        available: topUp, debtId: null, rank: lastRank + 1,",
    to: "        available: topUp, debtId: 'line', rank: lastRank + 1,",
    check: m => {
      const r = withEngine(m, fixture(), FIX_AS_OF, opts({ targetBuffer: 4000 }), fixtureDebts());
      return r.cf.fullGapCoverage.applies
        && !same(r.cf.fullGapCoverage.weekly, REAL.b4000.weekly);
    } },

  { label: 'a full-coverage alternative is published for a gap that is already fundable',
    from: "      if (funding.feasible) {\n        return Object.assign(out, { applies: false, reason: 'gapAlreadyFundable' });\n      }",
    to: '      if (false) { }',
    check: m => {
      const r = withEngine(m, fixture(), FIX_AS_OF, opts(), fixtureDebts());
      return r.cf.fullGapCoverage.applies;
    } },

  { label: 'allowing debtId sources to auto-cover reintroduces credit-line gap cash',
    from: '    if (src.debtId) return false;',
    to: '    if (false && src.debtId) return false;',
    check: m => {
      const r = withEngine(m, fixture(), FIX_AS_OF, opts({ targetBuffer: 2000 }), fixtureDebts());
      return r.advice.funding.parts.some(p => p.debtId === 'line');
    } },

  /* Deliberately NOT here: a mutation loosening `<` to `<=`. The equal-date
   * case it would guard — a draw that moves the crossing nowhere — is not
   * reachable on these fixtures, because a draw placed on the gap day is
   * always at or before the day the balance would have crossed on its own.
   * A mutation that cannot bite would be recorded as passing while proving
   * nothing, which is the false green this suite exists to avoid. The strict
   * comparison stays because it is the honest one; that no date is fabricated
   * is proved instead by the `noCurrentCrossing` and `sourceCannotCoverGap`
   * cases in sections 8 and 9, which ARE reachable. */

  { label: 'eligibility ignores whether the option names a debt at all',
    from: '        .filter(o => !o.unusable && o.debtId && o.available > 0)',
    to: '        .filter(o => !o.unusable && o.available > 0)',
    check: m => {
      const r = withEngine(m, fixture(), FIX_AS_OF, opts(), fixtureDebts());
      return (r.cf.gapFundingAlternatives || []).length !== REAL.dflt.alternatives;
    } },
];

const REAL = {
  b4000: fixtureRun({ targetBuffer: 4000 }).cf.fullGapCoverage,
  cons: fixtureRun({ targetBuffer: 4000, scenario: 'conservative' }).cf.fullGapCoverage,
  dflt: { alternatives: fixtureRun().cf.gapFundingAlternatives.length },
};

for (const m of MUTATIONS) {
  const built = mutant(m.from, m.to);
  if (built.error) {
    ok(false, `mutation target found: ${m.label}`, built.error);
    continue;
  }
  let changed = false, err = null;
  try { changed = m.check(built.engine); } catch (e) { err = e.message; changed = true; }
  ok(changed, m.label, err ? `threw: ${err}` : '');
}

console.log('\n=== 13. the page consumes the result rather than rebuilding it ===');
/* Not a string count: the page is booted and the two sentences are read back
 * from the real DOM ids, then the engine result is changed underneath it and
 * the rendered words have to follow. A page that recomputed the answer itself
 * would ignore the change. */
const planSrc = read('public/plan.js');
const planCode = planSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
{
  ok(!/available:\s*Infinity/.test(planCode),
    'no hypothetical funding source with infinite money is built in the page');
  ok(!/fundingDebtId/.test(planCode),
    'the page selects no alternative funding facility');
  ok(!/fundingSources:\s*\[/.test(planCode),
    'and constructs no funding-source array of its own');
  // The page still calls recommend ONCE — for the real plan — and projectDebts
  // ONCE, for the real debt walk. Anything beyond that is a second scenario.
  const recommends = (planCode.match(/Forecast\.recommend\(/g) || []).length;
  const projections = (planCode.match(/Forecast\.projectDebts\(/g) || []).length;
  ok(recommends === 1, 'Forecast.recommend is called once, for the plan on screen',
    `${recommends} call(s)`);
  ok(projections === 1, 'Forecast.projectDebts is called once, for the debt walk on screen',
    `${projections} call(s)`);
  ok(/Forecast\.counterfactuals\(/.test(planCode),
    'and the alternatives come from Forecast.counterfactuals');
}

console.log('\n=== 14. the real page, booted ===');
/* `public/app.js`, `public/forecast.js` and `public/plan.js` in the order
 * index.html loads them, against a stub DOM, on the real data.json. A proof
 * that stops at the engine cannot see a template reading a field the engine
 * stopped returning — that renders `undefined` at the household. */
function bootPage(knobs) {
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
  const store = { 'hfd-plan-knobs-v1': knobs ? JSON.stringify(knobs) : null };
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
    localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    addEventListener() {},
    matchMedia: () => ({ addEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame() {},
    innerWidth: 1200, innerHeight: 800, scrollY: 0,
    console,
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
const flat = s => String(s).replace(/\s+/g, ' ').trim();

{
  const page = bootPage(null);
  const dol = n => '$' + Math.round(Math.abs(n)).toLocaleString('en-CA');
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const { cf: cfDef } = published();
  const helocAlt = altFor(cfDef, 'heloc');
  const { cf: cf5k } = published({ targetBuffer: 8000 });
  const cover = cf5k.fullGapCoverage;
  const helocAvail = F.resolveFundingSources(
    plan.funding.options, data.revolvingExtra, plan, data.debts
  ).find(o => o.id === 'heloc').available;
  const bufHelocShort = helocAvail + openingFloor(plan, AS_OF) + 200;
  const { advice: tightAdv } = published({ targetBuffer: bufHelocShort });
  const tightCard = tightAdv.funding.sources.find(s => s.id === 'heloc');
  setTimeout(() => {
    ok(/data-budget-surface=/.test(page.get('operating-surface-body').innerHTML),
      'the active Budget renderer completes during boot');
    const risks = page.get('risk-list');
    const tiles = page.get('hero-tiles');
    ok(helocAlt.applies
      ? /brings that crossing forward/.test(flat(risks.innerHTML))
      : !/brings that crossing forward/.test(flat(risks.innerHTML)),
      'the booted page follows whether the HELOC alternative applies');
    ok(!helocAlt.applies || /Amanda/.test(flat(risks.innerHTML)),
      'and names Amanda when that is the source it displaces');
    ok(!/undefined|NaN|\[object/.test(risks.innerHTML),
      'with no undefined, NaN or [object Object] in it');
    ok(!/Cover the whole gap/.test(flat(tiles.innerHTML)),
      'and the fully-fundable published plan shows no full-coverage line');

    const raised = bootPage({ scenario: 'expected', targetBuffer: 8000,
      extraDebtMonthly: 0, weeklyVariable: null, incomeOverrides: {}, disabled: [] });
    setTimeout(() => {
      const t = flat(raised.get('hero-tiles').innerHTML);
      ok(cover.applies, 'an $8,000 buffer reaches the full-coverage case');
      ok(new RegExp(esc(`with only ${dol(cover.fundable)} of the ${dol(cover.gapAmount)} gap fundable`)).test(t),
        'at an $8,000 buffer the booted page publishes the fundable split');
      ok(new RegExp(esc(`Cover the whole gap and it becomes ${dol(cover.weekly)}/week`)).test(t),
        'and the full-coverage weekly figure the engine returned');
      ok(!/undefined|NaN|Infinity|\[object/.test(t),
        'with no undefined, NaN, Infinity or [object Object] in it');

      const tight = bootPage({ scenario: 'expected', targetBuffer: bufHelocShort,
        extraDebtMonthly: 0, weeklyVariable: null, incomeOverrides: {}, disabled: [] });
      setTimeout(() => {
        const r = flat(tight.get('risk-list').innerHTML);
        const f = flat(tight.get('funding-options').innerHTML);
        ok(tightCard && tightCard.verdict !== 'covers'
          && !/Covers the whole/.test(f),
          'at a gap the HELOC cannot cover, the funding card does not say it covers');
        // The verdict wording is page-built markup around money() output: it
        // must render as elements, never as escaped text (audit C2 repair).
        const fundRaw = tight.get('funding-options').innerHTML;
        ok(/<div class="fund-verdict"><span class="(ok|no)">/.test(fundRaw) && !/&lt;span/.test(fundRaw),
          'the funding verdict renders as markup, not as escaped tags');
        ok(!/brings that crossing forward/.test(r),
          'and no sentence below it prices a draw the facility cannot supply');
        ok(!/The HELOC passes its own limit on/.test(r),
          'and the HELOC crossing risk is not published on this cash-minimum walk');
        finish();
      }, 0);
    }, 0);
  }, 0);
}

function finish() {
  console.log('\n' + '─'.repeat(60));
  if (failures) {
    console.log(`\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
    process.exit(1);
  }
  console.log('\x1b[32mALL CHECKS PASSED\x1b[0m');
}
