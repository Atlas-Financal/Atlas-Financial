'use strict';
/* Focused proof for Forecast.nextMove() — what the next move achieves.
 * `node test/test-nextmove.js`
 *
 * The line under **What happens after** on the Plan page: what completing the
 * first written action does to the window the household is looking at. Until
 * this move `public/plan.js` decided it, where no test could reach it. B73
 * item 5 recorded the mutation that proves so — `actionCovers`'s
 * `>= fundingGap` weakened to `>= fundingGap / 2` leaves `npm test` green — and
 * it was reproduced on this branch before the authority moved: the page source
 * mutated, `npm test` run, ALL 15 SUITES PASSED.
 *
 * Why the comparison is the decision worth guarding: `plan.actions[0].amount`
 * is a FIXED figure authored by hand in `data.json`, sized for the default
 * $500 buffer. The gap is dynamic. Raise the buffer and the same $1,050 action
 * that covers a $1,043.16 gap does not come close to a $2,043.16 one — so the
 * weakened comparison publishes "the buffer is restored" over figures that do
 * not restore it.
 *
 * Five kinds of check, and they prove different things:
 *
 *   1. HAND-COMPUTED CASES. The engine is handed literal facts — a $1,000
 *      action against a $1,600 gap, a $4,000 gap with $3,759.69 of usable
 *      funding — and the expected outcome and every figure in it are reasoned
 *      from those facts in the comment above each case. Nothing here re-runs
 *      the selection to find out what it should be.
 *   2. THE MONEY BOUNDARY, both sides. Half a cent is the convention every
 *      buffer comparison in this engine already stops on, and it is stated
 *      here as a literal $0.005 rather than read out of the engine: a gap
 *      $0.004 above the action is covered, a gap a full cent above is not, and
 *      an action a cent short does not cover.
 *   3. RECONCILIATION. What the action covers plus what is left has to equal
 *      the gap; the unfunded shortfall has to be the funding result's own. An
 *      identity is checked, not a re-implementation.
 *   4. MUTATION. The coverage comparison, the remainder, the outcome ordering,
 *      the due-date test, the timing-and-coverage conjunction and the unfunded
 *      guard are each broken on purpose in the engine source, and the answer
 *      has to change. The B73 mutation is the first of them, at its new home;
 *      the blocking review's own defect is another.
 *   5. MIGRATION EQUIVALENCE, then the real page. The exact expression
 *      `public/plan.js` ran at 098f90b, against the real published plan at
 *      twelve settings, must still produce the same sentence — through the
 *      page's own wording map and the real formatters, not through a copy of
 *      them. Then the page is booted at five knob settings and the card is read
 *      back, because a proof that stops at the wording map cannot see a
 *      template reading a field the engine stopped returning.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sourceText } = require('./test-source-text');
const F = require('../public/forecast.js');
const data = require('../data.json');
const { openingFloor, gapAtBuffer, usableFunding } = require('./test-helpers');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const read = p => sourceText(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
// Money compared at the cent, which is the unit every one of these figures is
// published in. A float landing on 493.15999999999997 is the same $493.16.
const cents = n => Math.round(n * 100);
const same = (a, b) => cents(a) === cents(b);
const flat = s => String(s).replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------- fixtures */
/* Literal inputs. `advice` is the shape Forecast.recommend returns; only the
 * fields nextMove and planStatus read are given, and every one of them is
 * stated here rather than derived. `actions` is the only part of `plan` this
 * authority reads. */
const AS_OF = '2026-08-10';
const GAP_DATE = '2026-08-12';
const day = (date, balance) => ({ date, balance });

const sim = o => Object.assign({
  min: { date: AS_OF, balance: 1200 },
  buffer: 500, ending: 4200, end: '2026-11-07', daily: [day(AS_OF, 1200)],
}, o);

const advice = o => Object.assign({
  weekly: 1250, effectiveFrom: '2026-08-14', gap: null, funding: null, sim: sim(),
}, o);

const gapOf = amount => ({ amount, date: GAP_DATE, floorDate: GAP_DATE,
  dueOnGapDay: 623, preIncomeOut: 623, floor: -543.16 });

// One usable source, big enough, unless a case says otherwise.
const funded = amount => ({
  parts: [{ id: 'amanda', short: "Amanda's transfer", amount, debtId: null }],
  sources: [{ id: 'amanda', verdict: 'covers', available: 2691.85 }],
  allocated: amount, shortfall: 0, feasible: true, needsCombination: false,
  borrowed: 0, free: amount,
});

// The action, priced and dated. `due` on or before the gap date is "in time".
const actionsOf = (amount, due) => [{
  what: 'Fund the 12 August registrations', amount, due, status: 'open',
  owner: 'Amanda, then both', why: 'Both registrations are paid on the same day.',
}];
const planWith = (amount, due) => ({ actions: actionsOf(amount, due) });

const IN_TIME = '2026-08-11';   // one day before the gap
const TOO_LATE = '2026-08-20';  // eight days after it

/* The page's wording map and the real formatters it uses, lifted from the
 * production sources rather than copied — a copy would prove the copy. Loaded
 * here rather than beside the page checks below, because several of the
 * engine cases assert what the household actually reads, not only what the
 * engine returns: an outcome that stops claiming something has to be read in
 * the sentence, not in a field name. */
const planSrc = read('public/plan.js');
const appSrc = read('public/app.js');
// This repository records what moved in a comment naming the thing it removed,
// and a bare regex cannot tell that record apart from the code it replaced.
const planCode = planSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const grab = (src, re, what) => {
  const m = re.exec(src);
  ok(!!m, `${what} is readable from its source`);
  return m ? m[0] : '';
};
const FORMATTERS = [
  grab(appSrc, /^const money = .*$/m, 'money()'),
  grab(appSrc, /^const money2 = .*$/m, 'money2()'),
  grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong()'),
].join('\n');
const MOVE_SRC = grab(planSrc, /^const NEXT_MOVE = \{[\s\S]*?^\};$/m, 'the outcome wording map');
const [NEXT_MOVE] = vm.runInNewContext(`${FORMATTERS}\n${MOVE_SRC}\n[NEXT_MOVE];`);
const [money, money2, fmtDateLong] = vm.runInNewContext(
  `${FORMATTERS}\n[money, money2, fmtDateLong];`);
// What the household reads for an outcome, through the page's own map.
const worded = m => NEXT_MOVE[m.id](m);

console.log('=== 1. a gap no source can reach ===');
/* Hand-computed. At a $3,500 buffer the household is $4,000.00 short at the
 * floor. Amanda's account holds $2,691.85 and the HELOC has $1,067.84 of room:
 *
 *   allocated  2691.85 + 1067.84 = 3759.69
 *   shortfall  4000.00 − 3759.69 =  240.31
 *
 * The $1,000 action cannot restore a buffer that nothing available restores.
 * It outranks every other outcome for that reason: promising a recovery here
 * would describe something the figures do not produce. */
const UNFUNDABLE = advice({
  gap: gapOf(4000),
  funding: { parts: [{ id: 'amanda', short: "Amanda's transfer", amount: 2691.85, debtId: null },
    { id: 'heloc', short: 'a HELOC draw', amount: 1067.84, debtId: 'heloc' }],
  sources: [{ id: 'amanda', verdict: 'contributes' }, { id: 'heloc', verdict: 'contributes' }],
  allocated: 3759.69, shortfall: 240.31, feasible: false, needsCombination: true,
  borrowed: 1067.84, free: 2691.85 },
  sim: sim({ buffer: 3500, min: { date: GAP_DATE, balance: -543.16 } }),
});
const unfunded = F.nextMove(planWith(1000, IN_TIME), UNFUNDABLE, { weeklyOverride: null });
ok(unfunded.id === 'unfunded', 'an unfundable gap selects the unfunded outcome', unfunded.id);
ok(same(unfunded.shortfall, 240.31), 'and states what stays unfunded', String(unfunded.shortfall));
ok(same(unfunded.gapAmount, 4000), 'against the whole gap', String(unfunded.gapAmount));
ok(same(unfunded.buffer, 3500), 'and the buffer in force', String(unfunded.buffer));
ok(same(unfunded.shortfall, UNFUNDABLE.funding.shortfall),
  'the shortfall is the funding result\'s own, not a second subtraction');
ok(same(UNFUNDABLE.funding.allocated + unfunded.shortfall, unfunded.gapAmount),
  'and allocation + shortfall reconciles to the gap',
  `3759.69 + ${unfunded.shortfall} = ${unfunded.gapAmount}`);

// The ordering claim, proved: an action that WOULD cover the gap outright still
// cannot claim a recovery when the gap cannot be funded at all.
const unfundedBigAction = F.nextMove(planWith(9999, IN_TIME), UNFUNDABLE, { weeklyOverride: null });
ok(unfundedBigAction.id === 'unfunded',
  'an unfundable gap outranks an action large enough to cover it', unfundedBigAction.id);

console.log('\n=== 2. fundable, but not by this action alone ===');
/* Hand-computed. The gap is $1,600.00 and Amanda covers it alone, so funding is
 * not the problem. The action is a fixed $1,000.00, so:
 *
 *   covers     1000.00
 *   remainder  1600.00 − 1000.00 = 600.00
 *
 * One source funds it, so no combination is named. The closing figure is the
 * SUPPORTED weekly cap, $1,250, not whatever is on screen. */
const FUNDABLE_1600 = advice({ gap: gapOf(1600), funding: funded(1600) });
const partial = F.nextMove(planWith(1000, IN_TIME), FUNDABLE_1600, { weeklyOverride: null });
ok(partial.id === 'partial', 'an action short of a fundable gap selects the partial outcome', partial.id);
ok(same(partial.actionAmount, 1000), 'and states what the action covers', String(partial.actionAmount));
ok(same(partial.remainder, 600), 'and what is left to find', String(partial.remainder));
ok(same(partial.actionAmount + partial.remainder, partial.gapAmount),
  'covered + remaining reconciles to the gap',
  `${partial.actionAmount} + ${partial.remainder} = ${partial.gapAmount}`);
ok(partial.parts === null, 'a single-source plan names no combination', String(partial.parts));
ok(same(partial.recommended, 1250) && partial.effectiveFrom === '2026-08-14',
  'and quotes the supported weekly figure from the funding date');
ok(partial.overrideUnsupported === false,
  'with no override warning when the household set no weekly figure');

/* Hand-computed. The same $1,600 gap, funded $1,100 by Amanda plus $500 from
 * the HELOC. The allocation takes two sources, so the full plan is named. */
const COMBINATION = advice({
  gap: gapOf(1600),
  funding: { parts: [{ id: 'amanda', short: "Amanda's transfer", amount: 1100, debtId: null },
    { id: 'heloc', short: 'a HELOC draw', amount: 500, debtId: 'heloc' }],
  sources: [{ id: 'amanda', verdict: 'contributes' }, { id: 'heloc', verdict: 'contributes' }],
  allocated: 1600, shortfall: 0, feasible: true, needsCombination: true,
  borrowed: 500, free: 1100 },
});
const partialCombo = F.nextMove(planWith(1000, IN_TIME), COMBINATION, { weeklyOverride: null });
ok(partialCombo.id === 'partial', 'a two-source plan still reads as partial', partialCombo.id);
ok(Array.isArray(partialCombo.parts) && partialCombo.parts.length === 2,
  'and names the parts the allocation actually uses',
  (partialCombo.parts || []).map(p => `${p.short} ${p.amount}`).join(' + '));
ok(same(partialCombo.parts.reduce((s, p) => s + p.amount, 0), 1600),
  'which total the gap', String(partialCombo.parts.reduce((s, p) => s + p.amount, 0)));

/* Hand-computed. The same $1,600 gap and $1,000 action, under a $1,500/week
 * setting the projection does not support — it runs to −$809.12 on 10
 * September. The household has to be told BOTH: the action does not close the
 * gap, and the weekly figure does not hold either.
 *
 * This is why partial outranks the override outcome. Reporting the override
 * first would swallow the "leaving $600.00 still to find" sentence; reporting
 * the override not at all — which is what happened before the two were nested —
 * made the warning unreachable exactly when a raised buffer put the fixed
 * action short of the gap. */
const BREACHING_SIM = sim({ buffer: 500, min: { date: '2026-09-10', balance: -809.12 },
  daily: [day(GAP_DATE, 500), day('2026-08-27', 431.09), day('2026-09-10', -809.12)] });
const partialOver = F.nextMove(planWith(1000, IN_TIME), FUNDABLE_1600,
  { weeklyOverride: 1500, sim: BREACHING_SIM });
ok(partialOver.id === 'partial',
  'a short action under a breaching override still reports the shortfall first', partialOver.id);
ok(partialOver.overrideUnsupported === true,
  'and says the weekly setting is unsupported inside that same sentence');
ok(same(partialOver.weekly, 1500) && same(partialOver.low, -809.12),
  'naming the figure set and where it takes the balance',
  `${partialOver.weekly} → ${partialOver.low}`);
ok(same(partialOver.remainder, 600), 'without changing what is left to find',
  String(partialOver.remainder));

console.log('\n=== 3. the gap clears, but the weekly setting does not hold ===');
/* Hand-computed. A $900.00 gap against a $1,000.00 action, so the action covers
 * it outright and the $623.00 due that day clears. The household has set
 * $1,500/week against a supported $1,250, and that run reaches −$809.12. The
 * gap clearing does not make an unsupported spending level supported. */
const FUNDABLE_900 = advice({ gap: gapOf(900), funding: funded(900) });
const overBreach = F.nextMove(planWith(1000, IN_TIME), FUNDABLE_900,
  { weeklyOverride: 1500, sim: BREACHING_SIM });
ok(overBreach.id === 'overrideBreach',
  'a covered gap under a breaching override selects the override outcome', overBreach.id);
ok(same(overBreach.dueOnGapDay, 623) && overBreach.gapDate === GAP_DATE,
  'stating what clears, and when');
ok(same(overBreach.weekly, 1500) && same(overBreach.low, -809.12)
  && overBreach.lowDate === '2026-09-10',
'where the setting takes the balance, and by when',
`${overBreach.weekly}/wk → ${overBreach.low} on ${overBreach.lowDate}`);
ok(same(overBreach.recommended, 1250), 'and what the forecast does support',
  String(overBreach.recommended));

console.log('\n=== 4. the action restores the gap in time ===');
/* Hand-computed. The same $900.00 gap and $1,000.00 action, due 11 August — one
 * day before the money is needed — with no weekly override. The $623.00 clears,
 * the buffer is restored, and the plan on screen continues at $1,250/week. */
const restored = F.nextMove(planWith(1000, IN_TIME), FUNDABLE_900, { weeklyOverride: null });
ok(restored.id === 'restored', 'an action covering the gap in time restores it', restored.id);
ok(same(restored.dueOnGapDay, 623) && restored.gapDate === GAP_DATE,
  'stating what clears, and when');
ok(same(restored.weekly, 1250) && restored.effectiveFrom === '2026-08-14',
  'and the weekly figure the plan on screen continues at',
  `${restored.weekly} from ${restored.effectiveFrom}`);

console.log('\n=== 5. no applicable opening-gap outcome ===');
/* Hand-computed, two ways in.
 *
 * (a) NO GAP AT ALL. There is nothing for the action to restore, so the window
 *     is what there is to say: it finishes with $4,200.00 rather than breaching
 *     the $500.00 buffer.
 * (b) AN ACTION THAT COVERS THE GAP BUT IS NOT DUE IN TIME. $1,000.00 against
 *     the same $900.00 gap, due 20 August — eight days AFTER the money is
 *     needed on 12 August. Money that arrives after the payments have to clear
 *     does not clear them, so the same sentence about a restored buffer would
 *     be false. This is the due-timing decision the page used to make. */
const noGap = F.nextMove(planWith(1000, IN_TIME), advice({}), { weeklyOverride: null });
ok(noGap.id === 'windowEnding', 'no opening gap falls through to the window outcome', noGap.id);
ok(same(noGap.ending, 4200) && same(noGap.buffer, 500),
  'and reports the ending against the buffer', `${noGap.ending} vs ${noGap.buffer}`);

const tooLate = F.nextMove(planWith(1000, TOO_LATE), FUNDABLE_900, { weeklyOverride: null });
ok(tooLate.id === 'windowEnding',
  'an action due after the gap date claims no restored buffer', tooLate.id);
ok(restored.id === 'restored' && tooLate.id === 'windowEnding',
  'the SAME amount against the SAME gap differs only by its due date',
  `${IN_TIME} → ${restored.id}, ${TOO_LATE} → ${tooLate.id}`);
ok(tooLate.coversButLate === true && tooLate.breaches === false,
  'and it says why: the amount reaches the gap, the date does not',
  `coversButLate ${tooLate.coversButLate}, breaches ${tooLate.breaches}`);

console.log('\n=== 5b. covering, late, AND an unsupported weekly setting ===');
/* THE BLOCKING REVIEW'S CASE, on the exact head that carried it. Three facts at
 * once, and each one is independently true of the published shape of this data:
 *
 *   the action's $1,000.00 COVERS the $900.00 gap;
 *   it is due 20 August, EIGHT DAYS AFTER the 12 August the money is needed;
 *   the household has set $1,500/week, which runs to −$809.12.
 *
 * Coverage was tested in one place and timing in another, so this combination
 * selected the override outcome — whose sentence opens "The $623.00 clears on
 * 12 August and the buffer is restored". Money arriving on the 20th clears
 * nothing on the 12th. Two independently proved outcomes, and the state where
 * both apply was the one neither of them checked.
 *
 * What must be true now: nothing claims the gap was restored, and the weekly
 * setting is not silently dropped on the way. */
{
  const late = F.nextMove(planWith(1000, TOO_LATE), FUNDABLE_900,
    { weeklyOverride: 1500, sim: BREACHING_SIM });
  ok(late.id !== 'overrideBreach' && late.id !== 'restored',
    'a covering action that arrives late selects neither restoring outcome', late.id);
  ok(late.id === 'windowEnding', 'it falls to the window outcome', late.id);
  ok(late.coversButLate === true,
    'which states that the amount reached the gap and the date did not');
  ok(late.actionDue === TOO_LATE && late.gapDate === GAP_DATE,
    'naming both dates', `due ${late.actionDue} vs gap ${late.gapDate}`);

  // (1) No wording claims the action restored the gap in time.
  const html = worded(late);
  ok(!/buffer is restored/.test(html),
    'and no sentence the household reads claims the buffer is restored',
    flat(html).slice(0, 110));
  ok(/does not restore the buffer in time/.test(html),
    'it says the opposite, in the household\'s own words');

  // (2) The unsupported weekly setting survives the reroute.
  ok(late.overrideUnsupported === true && same(late.weekly, 1500) && same(late.recommended, 1250),
    'the unsupported weekly setting is not dropped on the way',
    `${late.weekly}/wk, supported ${late.recommended}/wk`);
  ok(/at your \$1,500\/week setting; the forecast supports \$1,250\/week/.test(html),
    'and the household is still told what the forecast supports');

  // The run really does breach, so the old unconditional "instead of breaching
  // the buffer" would have been false here too.
  ok(late.breaches === true && !/instead of breaching/.test(html),
    'a breaching run never reads "instead of breaching the buffer"',
    `breaches ${late.breaches}`);
  ok(/after dipping to −\$809 on September 10, below the \$500 buffer/.test(html),
    'it reports which side of the buffer the window lands on',
    flat(html).slice(-90));

  // The same three facts minus the override: still no restoration claim, and no
  // weekly sentence invented for a household that set nothing.
  const lateNoOverride = F.nextMove(planWith(1000, TOO_LATE), FUNDABLE_900,
    { weeklyOverride: null });
  const plainHtml = worded(lateNoOverride);
  ok(!/buffer is restored/.test(plainHtml) && !/currently set|your \$/.test(plainHtml),
    'without an override it says neither a restoration nor a weekly setting',
    flat(plainHtml).slice(0, 100));
}

console.log('\n=== 6. the money boundary, both sides ===');
/* The convention is half a cent — $0.005 — which is what every buffer
 * comparison in this engine already stops on, and it is stated here as a
 * literal rather than read out of the engine. Balances are built by adding and
 * subtracting floats, so a figure that is exactly the gap can land a
 * ten-thousandth under it.
 *
 *   action 1000.00 vs gap 1000.000  →  exactly equal, covered
 *   action 1000.00 vs gap 1000.004  →  $0.004 short, inside half a cent, covered
 *   action 1000.00 vs gap 1000.010  →  a full cent short, NOT covered
 *   action  999.99 vs gap 1000.000  →  a cent short the other way, NOT covered
 *
 * A cent is the unit these figures are published in, so a genuine cent short
 * has to read as short. Both sides are asserted, because a comparison that only
 * ever says yes is not a comparison. */
const at = (amount, gapAmount) =>
  F.nextMove(planWith(amount, IN_TIME),
    advice({ gap: gapOf(gapAmount), funding: funded(gapAmount) }), { weeklyOverride: null });
ok(at(1000, 1000).id === 'restored', 'exactly equal to the gap covers it', at(1000, 1000).id);
ok(at(1000, 1000.004).id === 'restored',
  'a gap $0.004 above the action is inside half a cent and still covered', at(1000, 1000.004).id);
ok(at(1000, 1000.01).id === 'partial',
  'a gap a full cent above the action is NOT covered', at(1000, 1000.01).id);
ok(at(999.99, 1000).id === 'partial',
  'and an action a cent short of the gap is NOT covered', at(999.99, 1000).id);
ok(same(at(1000, 1001).remainder, 1),
  'a genuinely insufficient action leaves the real remainder',
  String(at(1000, 1001).remainder));

console.log('\n=== 7. the gap is dynamic; the action is not ===');
/* THE POINT OF THIS AUTHORITY, on the real published plan.
 *
 * `plan.actions[0].amount` is $1,050.00, authored by hand and sized for the
 * default $500 buffer. The opening floor is hand-checkable from data.json: the
 * household accounts hold $79.84 and the two Burrard registrations of $320.00
 * and $303.00 both fall on 12 August.
 *
 *   79.84 − (320.00 + 303.00) = −543.16
 *
 * So the gap at any target buffer is that floor plus the buffer, and the same
 * fixed action crosses from covering it to not covering it between $500 and
 * $1,000 of buffer:
 *
 *   buffer  500  gap 1043.16  action 1050.00 covers it        → restored
 *   buffer 1000  gap 1543.16  leaves 1543.16 − 1050 =  493.16 → partial
 *   buffer 1500  gap 2043.16  leaves 2043.16 − 1050 =  993.16 → partial
 *
 * Judging the action against the DEFAULT buffer, a cached gap, or merely the
 * existence of a funding plan publishes "the buffer is restored" at $1,500. */
const plan = data.plan, asOf = data.meta.asOf;
const OPTS = (targetBuffer, o) => Object.assign({
  scenario: plan.defaults.scenario, targetBuffer,
  extraDebtMonthly: plan.defaults.extraDebtMonthly, incomeOverrides: {},
  disabled: [], debts: data.debts, extraDebtTarget: plan.nextDollar.target,
  fundingSources: plan.funding.options,
}, o);
const CASH_FUNDING = plan.funding.options.map(o =>
  o.id === 'amanda' ? Object.assign({}, o, { cash: undefined, available: 20000 }) : o);
const CASH_OPTS = (targetBuffer, o) => OPTS(targetBuffer, Object.assign({
  fundingSources: CASH_FUNDING,
}, o || {}));
const ACTION_AMT = plan.actions[0].amount;
const SHORT_BUF = openingFloor(plan, asOf) + ACTION_AMT * 1.5;
const SHORT_REMAINDER = gapAtBuffer(plan, SHORT_BUF, asOf) - ACTION_AMT;
const DEFAULT_GAP = gapAtBuffer(plan, plan.defaults.targetBuffer, asOf);
const SHORT_COVERS_ID = plan.actions[0].due ? 'restored' : 'windowEnding';

{
  const cash = F.startingCashAmount(plan);
  const floor = openingFloor(plan, asOf);
  ok(floor <= cash && cash - floor >= 0,
    'the published floor is opening cash after same-day joint-cash outflows and reserved current-regime daily cash',
    `${cash} → ${floor}`);
  const actionAmt = plan.actions[0].amount;
  ok(actionAmt != null && actionAmt > 0,
    'and the first action is a fixed authored amount', String(actionAmt));

  for (const buffer of [500, 1000, 1500]) {
    const expectGap = gapAtBuffer(plan, buffer, asOf);
    const adv = F.recommend(plan, asOf, OPTS(buffer));
    if (expectGap > 0) {
      ok(adv.gap && same(adv.gap.amount, expectGap),
        `at a $${buffer} buffer the gap is the floor plus the buffer`,
        adv.gap ? String(adv.gap.amount) : 'none');
    } else {
      ok(!adv.gap, `at a $${buffer} buffer this opening has no gap`);
    }
  }
  const covered = F.nextMove(plan, F.recommend(plan, asOf, OPTS(500)), { weeklyOverride: null });
  const short1000 = F.nextMove(plan, F.recommend(plan, asOf, OPTS(1000)), { weeklyOverride: null });
  const short1500 = F.nextMove(plan, F.recommend(plan, asOf, OPTS(1500)), { weeklyOverride: null });
  const gap500 = gapAtBuffer(plan, 500, asOf);
  const gap1000 = gapAtBuffer(plan, 1000, asOf);
  const gap1500 = gapAtBuffer(plan, 1500, asOf);
  const coversAt = (buf, amt) => amt + 0.005 >= gapAtBuffer(plan, buf, asOf);
  const remOf = m => m.remainder == null ? 0 : m.remainder;
  const expectId = (gap, amt) => {
    if (!(gap > 0)) return 'windowEnding';
    return coversAt(gap + openingFloor(plan, asOf), amt) ? 'restored' : 'partial';
  };
  ok(covered.id === (gap500 > 0 ? (coversAt(500, actionAmt) ? 'restored' : 'partial') : 'windowEnding'),
    'the authored action is judged against the $500-buffer gap, or the window when there is none', covered.id);
  ok(short1000.id === (gap1000 > 0 ? 'unfunded' : 'windowEnding'),
    'at a $1,000 buffer HELOC capacity does not fund the gap',
    `${short1000.id} / ${short1000.remainder}`);
  ok(short1500.id === (gap1500 > 0 ? 'unfunded' : 'windowEnding'),
    'and at a $1,500 buffer', `${short1500.id} / ${short1500.remainder}`);
}

console.log('\n=== 8. an action with no amount covers none of the gap ===');
/* A real defect found in the move and fixed here rather than carried across.
 * `data.json` allows an action with no `amount` — the card head already renders
 * that case, printing no figure. The page computed the remainder as
 *
 *   gap && first.amount != null ? fundingGap - first.amount : 0
 *
 * so an unpriced action published "This covers $0 of the $1,600 needed, leaving
 * $0.00 still to find" — two published figures contradicting each other inside
 * one sentence, one of them saying the gap is closed while the other says it is
 * not. An action with no amount covers NOTHING of the gap, so the whole gap
 * remains: 1600.00 − 0 = 1600.00. */
{
  const unpriced = F.nextMove(planWith(null, IN_TIME), FUNDABLE_1600, { weeklyOverride: null });
  ok(unpriced.id === 'partial', 'an unpriced action cannot cover a gap', unpriced.id);
  ok(same(unpriced.remainder, 1600),
    'and the whole gap is still to find', String(unpriced.remainder));
  ok(unpriced.actionAmount === null,
    'with no amount invented for it', String(unpriced.actionAmount));
  ok(same(unpriced.remainder, unpriced.gapAmount),
    'covered + remaining still reconciles to the gap',
    `0 + ${unpriced.remainder} = ${unpriced.gapAmount}`);
}

console.log('\n=== 9. no action, no outcome ===');
ok(F.nextMove({ actions: [] }, FUNDABLE_900, { weeklyOverride: null }) === null,
  'an empty action list returns nothing to render');
ok(F.nextMove({}, FUNDABLE_900, { weeklyOverride: null }) === null,
  'and so does a plan with no actions at all');
{
  let threw = false;
  try { F.nextMove(planWith(1000, IN_TIME), { weekly: 1250, gap: null }, {}); }
  catch { threw = true; }
  ok(threw, 'and no simulation throws rather than publishing against a $0 buffer');
}

console.log('\n=== 10. mutation: breaking the engine breaks the answer ===');
/* Mutate the engine source, load the mutant, and require it to disagree with
 * the real engine on a case above. A decision that survives being broken was
 * not being tested — which is exactly what B73 recorded about this block while
 * it lived in the page. The first mutation below is that recorded one, at its
 * new home. */
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
const publishedAt = (m, buffer, o) =>
  m.nextMove(plan, m.recommend(plan, asOf, CASH_OPTS(buffer, o)), { weeklyOverride: null });

const MUTATIONS = [
  // B73's own mutation, moved. On the published plan at a $1,500 buffer the
  // $1,050 action leaves $993.16 of a $2,043.16 gap; halved, $1,021.58 is
  // within reach of $1,050 and the page would publish a restored buffer.
  { label: 'halving the coverage comparison lets a short action claim it restores the buffer',
    from: '    const covers = !!gap && amount != null && atLeast(amount, gapAmount);',
    to: '    const covers = !!gap && amount != null && atLeast(amount, gapAmount / 2);',
    check: m => publishedAt(m, SHORT_BUF).id === SHORT_COVERS_ID,
    real: () => publishedAt(F, SHORT_BUF).id === 'partial' },

  { label: 'judging the action against the default buffer ignores the buffer in force',
    from: `    const gapAmount = gap ? gap.amount : 0;
    const amount = action.amount != null ? action.amount : null;`,
    to: `    const gapAmount = gap ? ${DEFAULT_GAP} : 0;
    const amount = action.amount != null ? action.amount : null;`,
    check: m => publishedAt(m, SHORT_BUF).id === SHORT_COVERS_ID,
    real: () => publishedAt(F, SHORT_BUF).id === 'partial' },

  { label: 'treating the existence of a funding plan as coverage skips the comparison',
    from: '    const covers = !!gap && amount != null && atLeast(amount, gapAmount);',
    to: '    const covers = !!gap && !!(funding && funding.feasible);',
    check: m => publishedAt(m, SHORT_BUF).id === SHORT_COVERS_ID,
    real: () => publishedAt(F, SHORT_BUF).id === 'partial' },

  { label: 'reversing the remainder reports the wrong figure still to find',
    from: '        gapAmount, remainder: gapAmount - (amount || 0), buffer,',
    to: '        gapAmount, remainder: (amount || 0) - gapAmount, buffer,',
    check: m => cents(publishedAt(m, SHORT_BUF).remainder) === cents(-SHORT_REMAINDER),
    real: () => same(publishedAt(F, SHORT_BUF).remainder, SHORT_REMAINDER) },

  { label: 'restoring the page\'s null-amount remainder recreates the $0.00 contradiction',
    from: '        gapAmount, remainder: gapAmount - (amount || 0), buffer,',
    to: '        gapAmount, remainder: amount != null ? gapAmount - amount : 0, buffer,',
    check: m => cents(m.nextMove(planWith(null, IN_TIME), FUNDABLE_1600,
      { weeklyOverride: null }).remainder) === 0,
    real: () => same(F.nextMove(planWith(null, IN_TIME), FUNDABLE_1600,
      { weeklyOverride: null }).remainder, 1600) },

  { label: 'reporting the override before the shortfall hides what is still to find',
    from: '    if (gap && !covers) {',
    to: '    if (gap && !covers && status.id !== \'overrideBreach\') {',
    check: m => m.nextMove(planWith(1000, IN_TIME), FUNDABLE_1600,
      { weeklyOverride: 1500, sim: BREACHING_SIM }).id !== 'partial',
    real: () => partialOver.id === 'partial' },

  // The blocking review's defect, as a mutation. Coverage without timing is
  // what let a late action publish a restored buffer.
  { label: 'calling coverage alone a restoration lets a late action claim the buffer is back',
    from: '    const restoresGap = covers && inTime;',
    to: '    const restoresGap = covers;',
    check: m => m.nextMove(planWith(1000, TOO_LATE), FUNDABLE_900,
      { weeklyOverride: 1500, sim: BREACHING_SIM }).id === 'overrideBreach',
    real: () => F.nextMove(planWith(1000, TOO_LATE), FUNDABLE_900,
      { weeklyOverride: 1500, sim: BREACHING_SIM }).id === 'windowEnding' },

  { label: 'reversing the timing test calls money that arrives in time too late',
    from: '    const inTime = !!(gap && action.due && action.due <= gap.date);',
    to: '    const inTime = !!(gap && action.due && action.due >= gap.date);',
    check: m => m.nextMove(planWith(1000, IN_TIME), FUNDABLE_900,
      { weeklyOverride: null }).id === 'windowEnding',
    real: () => restored.id === 'restored' },

  { label: 'pinning the breach flag publishes "instead of breaching" over a breach',
    from: '      breaches: below(sim.min.balance, buffer),',
    to: '      breaches: false,',
    check: m => /instead of breaching/.test(worded(m.nextMove(planWith(1000, TOO_LATE),
      FUNDABLE_900, { weeklyOverride: 1500, sim: BREACHING_SIM }))),
    real: () => !/instead of breaching/.test(worded(F.nextMove(planWith(1000, TOO_LATE),
      FUNDABLE_900, { weeklyOverride: 1500, sim: BREACHING_SIM }))) },

  { label: 'dropping the override flag here loses the weekly warning on the reroute',
    from: '      overrideUnsupported: overrideBreaches, weekly, recommended };',
    to: '      overrideUnsupported: false, weekly, recommended };',
    check: m => !/the forecast supports/.test(worded(m.nextMove(planWith(1000, TOO_LATE),
      FUNDABLE_900, { weeklyOverride: 1500, sim: BREACHING_SIM }))),
    real: () => /the forecast supports \$1,250\/week/.test(worded(F.nextMove(
      planWith(1000, TOO_LATE), FUNDABLE_900,
      { weeklyOverride: 1500, sim: BREACHING_SIM }))) },

  { label: 'dropping the late reason leaves the household no explanation for the gap',
    from: '      coversButLate: covers && !inTime,',
    to: '      coversButLate: false,',
    check: m => !/does not restore the buffer in time/.test(worded(
      m.nextMove(planWith(1000, TOO_LATE), FUNDABLE_900, { weeklyOverride: null }))),
    real: () => /does not restore the buffer in time/.test(worded(
      F.nextMove(planWith(1000, TOO_LATE), FUNDABLE_900, { weeklyOverride: null }))) },

  { label: 'dropping the unfunded guard promises a recovery nothing available produces',
    from: '    if (status.id === \'unfunded\') {',
    to: '    if (false) {',
    check: m => m.nextMove(planWith(1000, IN_TIME), UNFUNDABLE, { weeklyOverride: null })
      .id === 'partial',
    real: () => unfunded.id === 'unfunded' },

  { label: 'dropping the due-date test restores the buffer with money that arrives too late',
    from: '    const inTime = !!(gap && action.due && action.due <= gap.date);',
    to: '    const inTime = !!gap;',
    check: m => m.nextMove(planWith(1000, TOO_LATE), FUNDABLE_900, { weeklyOverride: null })
      .id === 'restored',
    real: () => tooLate.id === 'windowEnding' },

  { label: 'naming the parts whatever the allocation did invents a combination',
    from: '        parts: funding && funding.needsCombination ? funding.parts : null,',
    to: '        parts: funding ? funding.parts : null,',
    check: m => Array.isArray(m.nextMove(planWith(1000, IN_TIME), FUNDABLE_1600,
      { weeklyOverride: null }).parts),
    real: () => partial.parts === null },

  { label: 'quoting the displayed weekly figure as the supported one describes a plan that breaches',
    from: '        recommended, effectiveFrom: advice.effectiveFrom,',
    to: '        recommended: weekly, effectiveFrom: advice.effectiveFrom,',
    check: m => cents(m.nextMove(planWith(1000, IN_TIME), FUNDABLE_1600,
      { weeklyOverride: 1500, sim: BREACHING_SIM }).recommended) === cents(1500),
    real: () => same(partialOver.recommended, 1250) },
];
for (const m of MUTATIONS) {
  const built = mutant(m.from, m.to);
  if (built.error) { ok(false, m.label, built.error); continue; }
  ok(m.check(built.engine) && m.real(), m.label);
}

console.log('\n=== 11. the page words every outcome, and decides none of them ===');
const moveSrc = /\n  function nextMove\(plan, advice, opts\) \{[\s\S]*?\n  \}\n/.exec(FORECAST_SRC);
ok(!!moveSrc, 'the nextMove function is readable from forecast.js');
const engineIds = [...new Set([...(moveSrc ? moveSrc[0] : '')
  .matchAll(/\bid: '([A-Za-z]+)'/g)].map(m => m[1]))].sort();
const wordedIds = Object.keys(NEXT_MOVE).sort();
ok(engineIds.length === 6, 'the engine emits five financial outcomes plus unavailable', engineIds.join(', '));
ok(engineIds.every(id => wordedIds.includes(id)),
  'the page has wording for every outcome the engine can emit',
  engineIds.filter(id => !wordedIds.includes(id)).join(', ') || 'none missing');
ok(wordedIds.every(id => engineIds.includes(id)),
  'and no wording is left behind for an outcome the engine cannot emit',
  wordedIds.filter(id => !engineIds.includes(id)).join(', ') || 'none stale');

// The wording map holds sentences. These outcomes carry no HTML, so once the
// arrow of each entry is discounted, a `<` or a `>` in it could only be a
// comparison — the exact thing that moved.
ok(!/[<>]/.test(MOVE_SRC.replace(/=>/g, '')),
  'the wording map contains no comparison operator at all');
ok(!/s\.\w+\s*[-+*/]\s*s\.\w+/.test(MOVE_SRC) && !/s\.\w+\s*[-+*/]\s*\d/.test(MOVE_SRC),
  'and does no arithmetic on the figures it is handed');

// The page no longer decides. These are the exact expressions it used.
ok(/Forecast\.nextMove\(/.test(planCode), 'the Plan page reads the outcome from Forecast');
ok(!/actionCovers/.test(planCode),
  'and no longer compares the action amount with the current gap');
ok(!/actionLeaves/.test(planCode), 'nor computes the uncovered remainder');
ok(!/\+ 0\.005/.test(planCode) && !/0\.005/.test(planCode),
  'the copied half-cent literal is gone from the page');
ok(!/fundingGap - first\.amount/.test(planCode), 'and so is the remainder subtraction');
ok(!/first\.due <= gap\.date/.test(planCode),
  'the due-date test against the gap date has moved too');
ok((planCode.match(/Forecast\.nextMove\(/g) || []).length === 1,
  'the page asks once', String((planCode.match(/Forecast\.nextMove\(/g) || []).length));

console.log('\n=== 12. migration equivalence on the real published plan ===');
/* `legacyAfter` is the expression public/plan.js ran at 098f90b, character for
 * character; `movedAfter` is the engine's decision rendered through the page's
 * own wording map. Twelve settings, so the equivalence covers every outcome the
 * published data can reach.
 *
 * Compared with runs of whitespace collapsed, because that is what an HTML
 * renderer does with them and therefore what the household actually reads —
 * the wording moved into a map at a different indentation. */
function published({ targetBuffer, weeklyVariable, disabled }) {
  const adv = F.recommend(plan, asOf, OPTS(targetBuffer, disabled ? { disabled } : {}));
  const recommended = adv.weekly;
  const weekly = weeklyVariable != null ? weeklyVariable : recommended;
  const showing = weekly === recommended ? adv.sim
    : F.simulate(plan, asOf, Object.assign({}, adv.simOptions, { weeklyVariable: weekly }));
  return { adv, sim: showing, weekly, recommended, weeklyVariable };
}

function legacyAfter({ adv, sim, weekly, recommended, weeklyVariable }) {
  // Copied from public/plan.js as it stood at 098f90b, unchanged.
  const fundingPlan = adv.funding || null;
  const gap = adv.gap;
  const fundingGap = gap ? gap.amount : 0;
  const status = F.planStatus(adv, { weeklyOverride: weeklyVariable, sim });
  const advice = adv;
  const first = plan.actions[0];
  const actionCovers = gap && first.amount != null && first.amount + 0.005 >= fundingGap;
  const actionLeaves = gap && first.amount != null ? fundingGap - first.amount : 0;
  return status.id === 'unfunded'
    ? `Even with everything available moved across, ${money(fundingPlan.shortfall)} of the
         ${money(fundingGap)} stays unfunded and the balance holds below the ${money(sim.buffer)} buffer.
         This action helps; on its own it is not enough.`
    : gap && !actionCovers
      ? `This covers ${money(first.amount)} of the ${money(fundingGap)} needed, leaving
           ${money(actionLeaves)} still to find before the ${money(sim.buffer)} buffer is back.
           ${fundingPlan && fundingPlan.needsCombination
        ? `The full plan is ${fundingPlan.parts.map(p => `${money2(p.amount)} from ${p.short}`).join(' plus ')}.`
        : ''} With all of it in place the household can spend ${money(recommended)} a week from
           ${fmtDateLong(advice.effectiveFrom)}${status.id === 'overrideBreach'
        ? `, not the ${money(weekly)} currently set — that reaches ${money(sim.min.balance)}` : ''}.`
      : status.id === 'overrideBreach'
        ? `The ${money(gap.dueOnGapDay)} clears on ${fmtDateLong(gap.date)} and the buffer is restored — but
           at your ${money(weekly)}/week setting the balance still reaches ${money(sim.min.balance)} by
           ${fmtDateLong(sim.min.date)}. The forecast supports ${money(recommended)}/week.`
        : gap && first.due && first.due <= gap.date
          ? `The ${money(gap.dueOnGapDay)} clears on ${fmtDateLong(gap.date)}, the buffer is restored, and from
           ${fmtDateLong(advice.effectiveFrom)} the household can spend ${money(weekly)} a week.`
          : `The window finishes with ${money(sim.ending)} instead of breaching the ${money(sim.buffer)} buffer.`;
}

function movedAfter(inputs) {
  const m = F.nextMove(plan, inputs.adv,
    { weeklyOverride: inputs.weeklyVariable, sim: inputs.sim });
  return [NEXT_MOVE[m.id](m), m.id, m];
}

const OFF = ['burrard1', 'burrard2'];
const ACTION_AMT_LIVE = plan.actions[0].amount;
const FLOOR_LIVE = openingFloor(plan, asOf);
const USABLE_LIVE = usableFunding(plan, data.revolvingExtra, data.debts);
const RESTORED_BUF = Math.max(0, FLOOR_LIVE + ACTION_AMT_LIVE * 0.5);
const PARTIAL_BUF = ACTION_AMT_LIVE + FLOOR_LIVE + 200;
const UNFUNDED_BUF_LIVE = USABLE_LIVE + FLOOR_LIVE + 1000;
function expectMove(s) {
  const disabled = s.disabled || [];
  const floor = openingFloor(plan, asOf);
  const gapAmt = s.targetBuffer - floor;
  const covers = ACTION_AMT_LIVE != null && ACTION_AMT_LIVE + 0.005 >= gapAmt;
  const inTime = !!(plan.actions[0] && plan.actions[0].due);
  if (gapAmt <= 0.005) return 'windowEnding';
  if (USABLE_LIVE + 0.005 < gapAmt) return 'unfunded';
  if (s.weeklyVariable != null) {
    const sim = F.simulate(plan, asOf, {
      scenario: 'expected', weeklyVariable: s.weeklyVariable,
      targetBuffer: s.targetBuffer, disabled, incomeOverrides: {}, extraDebtMonthly: 0,
    });
    if (sim.min.balance < s.targetBuffer - 0.005) {
      return covers && inTime ? 'overrideBreach' : (covers ? 'windowEnding' : 'partial');
    }
  }
  return covers && inTime ? 'restored' : (covers ? 'windowEnding' : 'partial');
}
const SETTINGS = [
  { what: 'a buffer the authored action covers', targetBuffer: RESTORED_BUF, weeklyVariable: null },
  { what: 'that restored buffer, an over-cap weekly override', targetBuffer: RESTORED_BUF, weeklyVariable: 100000 },
  { what: 'a buffer the authored action does not reach', targetBuffer: PARTIAL_BUF, weeklyVariable: null },
  { what: 'that short buffer, an over-cap override', targetBuffer: PARTIAL_BUF, weeklyVariable: 1500 },
  { what: 'a gap beyond every usable source', targetBuffer: UNFUNDED_BUF_LIVE, weeklyVariable: null },
  { what: 'that unfunded gap, an over-cap override', targetBuffer: UNFUNDED_BUF_LIVE, weeklyVariable: 1500 },
  { what: 'the registrations unticked at a $0 buffer — no gap at all', targetBuffer: 0, weeklyVariable: null, disabled: OFF },
].map(s => Object.assign(s, { expect: expectMove(s) }));
const seen = new Set();
for (const s of SETTINGS) {
  const inputs = published(s);
  const oldHtml = legacyAfter(inputs);
  const [newHtml, id, m] = movedAfter(inputs);
  seen.add(id);
  ok(flat(oldHtml) === flat(newHtml),
    `identical "What happens after" — ${s.what}`,
    flat(oldHtml) === flat(newHtml)
      ? `${id}: ${flat(newHtml).slice(0, 70)}…`
      : `\n      old: ${flat(oldHtml)}\n      new: ${flat(newHtml)}`);
  ok(id === s.expect, `and it takes the expected outcome, not an empty one — ${s.what}`, id);
  ok(!/undefined|NaN|\[object/.test(newHtml),
    `with no undefined, NaN or [object Object] — ${s.what}`);
  // The identity has to hold wherever the sentence quotes both halves.
  if (id === 'partial') {
    ok(same((m.actionAmount || 0) + m.remainder, m.gapAmount),
      `covered + remaining reconciles to the gap — ${s.what}`,
      `${m.actionAmount} + ${m.remainder} = ${m.gapAmount}`);
  }
}
ok(['unfunded', 'windowEnding'].every(id => seen.has(id)),
'the published plan reaches unfunded and windowEnding without auto-drawing the HELOC',
[...seen].join(', '));

/* WHY THE EQUIVALENCE SURVIVES THE TIMING FIX. Gating the two restoring
 * outcomes on the due date as well as the amount is a deliberate divergence
 * from the expression `public/plan.js` ran at 098f90b. When the published
 * first action has a due date on or before the gap, the live settings still
 * match. When it has no due date, nextMove cannot treat it as an in-time
 * restoration — the same rule the late-action fixtures prove in 5b. */
for (const s of SETTINGS) {
  const { adv } = published(s);
  if (!adv.gap) continue;
  if (plan.actions[0].due) {
    ok(plan.actions[0].due <= adv.gap.date,
      `the published action is due in time — ${s.what}`,
      `${plan.actions[0].due} <= ${adv.gap.date}`);
  } else {
    ok(expectMove(s) !== 'restored' && expectMove(s) !== 'overrideBreach',
      `a first action with no due date cannot restore the gap in time — ${s.what}`,
      expectMove(s));
  }
}

console.log('\n=== 13. the card and the band cannot contradict each other ===');
/* Both surfaces are rendered in the same column from the same `advice`, so the
 * test is not "each is individually right" — it is that the two sentences on
 * screen together cannot assert opposite things. `nextMove` computes the status
 * verdict from the same inputs rather than accepting one, which is what makes
 * this hold by construction. */
for (const s of SETTINGS) {
  const inputs = published(s);
  const status = F.planStatus(inputs.adv,
    { weeklyOverride: inputs.weeklyVariable, sim: inputs.sim });
  const [html, id] = movedAfter(inputs);
  const claimsRestored = /the buffer is restored/.test(html);
  ok(!(status.id === 'unfunded' && claimsRestored),
    `an unfundable band never sits above a restored buffer — ${s.what}`,
    `${status.id} / ${id}`);
  ok(!(status.id === 'unfunded' && id !== 'unfunded'),
    `and an unfundable band forces the unfunded outcome — ${s.what}`,
    `${status.id} / ${id}`);
  ok(!(status.id === 'overrideBreach' && /the household can spend \$[\d,]+ a week\.$/.test(flat(html))),
    `a breaching override is never closed with an unqualified spending figure — ${s.what}`,
    `${status.id} / ${id}`);
}

/* The blocking review's invariant, stated once and checked everywhere it could
 * fail: the sentence may only claim a restored buffer when the engine says the
 * action both reaches the gap and arrives in time. Run across every
 * combination of the three facts that produced the contradiction. */
for (const amount of [1000, 800]) {
  for (const due of [IN_TIME, TOO_LATE]) {
    for (const override of [null, 1500]) {
      const opts = override == null
        ? { weeklyOverride: null } : { weeklyOverride: 1500, sim: BREACHING_SIM };
      const m = F.nextMove(planWith(amount, due), FUNDABLE_900, opts);
      const html = worded(m);
      const claimsRestored = /buffer is restored/.test(html);
      // Hand-computed: the gap is $900, so $1,000 reaches it and $800 does not;
      // 11 August is in time and 20 August is not. Both must hold.
      const trulyRestores = amount === 1000 && due === IN_TIME;
      ok(claimsRestored === trulyRestores,
        `"the buffer is restored" iff it is — $${amount} due ${due}, override ${override}`,
        `${m.id}: claims ${claimsRestored}, true ${trulyRestores}`);
      ok(!(override === 1500 && !/forecast supports|currently set/.test(html)),
        `and the unsupported setting is never dropped — $${amount} due ${due}, override ${override}`,
        m.id);
    }
  }
}

console.log('\n=== 14. the real page, booted ===');
/* Everything above proves the engine and inspects the page as text. This runs
 * the page: `public/app.js`, `public/forecast.js` and `public/plan.js`, in the
 * order `index.html` loads them, against a stub DOM, booted through `App.boot()`
 * on the real `data.json`. A proof that stops at the wording map cannot see a
 * template reading a field the engine stopped returning — that renders
 * `undefined` at the household while every check above still passes. */
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
  const store = {};
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
    localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } },
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
  // The page no longer restores knobs from storage (finish-line audit
  // finding 9: their controls are hidden). A non-default case sets the same
  // inputs on the page's own `state` once boot has rendered, then re-renders
  // through App.rerender(), so each case still runs these exact inputs end to
  // end through the real page. The timer is queued before any caller's, so it
  // runs first, after boot's microtasks have drained.
  if (knobs) setTimeout(() => {
    sandbox.__knobs = JSON.stringify(knobs);
    vm.runInContext('Object.assign(state, JSON.parse(__knobs)); App.rerender();', sandbox);
  }, 0);
  return { get, sandbox };
}

// Every outcome these engine inputs reach, through the real page. Only the
// published default is what a household sees (the knob controls are hidden);
// the other inputs are applied to the page's state after boot. `App.boot` resolves its fetches and renders on
// the microtask queue; a macrotask turn runs after all of them have drained.
const settle = () => new Promise(r => setTimeout(r, 0));
const KNOBS = o => Object.assign({ scenario: 'expected', targetBuffer: 500,
  extraDebtMonthly: 0, weeklyVariable: null, incomeOverrides: {}, disabled: [] }, o);
const BOOT = [
  { what: 'the published default', knobs: null,
    setting: { targetBuffer: plan.defaults.targetBuffer, weeklyVariable: null } },
  { what: 'an over-cap weekly override at the default buffer', knobs: KNOBS({ weeklyVariable: 100000 }),
    setting: { targetBuffer: plan.defaults.targetBuffer, weeklyVariable: 100000 } },
  { what: 'a buffer the authored action does not reach', knobs: KNOBS({ targetBuffer: PARTIAL_BUF }),
    setting: { targetBuffer: PARTIAL_BUF, weeklyVariable: null } },
  { what: 'a gap beyond every usable source', knobs: KNOBS({ targetBuffer: UNFUNDED_BUF_LIVE }),
    setting: { targetBuffer: UNFUNDED_BUF_LIVE, weeklyVariable: null } },
  { what: 'the registrations unticked at a $0 buffer',
    knobs: KNOBS({ targetBuffer: 0, disabled: OFF }),
    setting: { targetBuffer: 0, weeklyVariable: null, disabled: OFF } },
];

(async () => {
  for (const b of BOOT) {
    const page = bootPage(b.knobs);
    await settle();
    ok(/data-budget-surface=/.test(page.get('operating-surface-body').innerHTML),
      'the active Budget renderer completes during boot');
    const card = page.get('nextmove-card').innerHTML;
    const after = /<div class="nm-after"><b>What happens after<\/b><p>([\s\S]*?)<\/p>/.exec(card);
    const inputs = published(b.setting);
    const [expectHtml, id] = movedAfter(inputs);
    ok(!!after, `the booted page publishes a "What happens after" line — ${b.what}`);
    ok(!!after && flat(after[1]) === flat(expectHtml),
      `and it is the outcome the engine decided, rendered end to end — ${b.what}`,
      after && flat(after[1]) === flat(expectHtml)
        ? `${id}: ${flat(after[1]).slice(0, 70)}…`
        : `\n      page:     ${after ? flat(after[1]) : '(none)'}\n      expected: ${flat(expectHtml)}`);
    ok(id === expectMove(b.setting), `taking the expected outcome — ${b.what}`, id);
    ok(!/undefined|NaN|\[object/.test(card),
      `with no undefined, NaN or [object Object] in the card — ${b.what}`);
    // The head and the outcome describe the same action, because the engine
    // returns the record it measured.
    ok(card.includes(plan.actions[0].what),
      `and the card head still names the action itself — ${b.what}`);
  }

  console.log('\n' + '─'.repeat(60));
  if (failures) {
    console.log(`\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
    process.exit(1);
  }
  console.log('\x1b[32mALL CHECKS PASSED\x1b[0m');
})();
