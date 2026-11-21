'use strict';
/* Focused proof for Forecast.mission(). `node test/test-mission.js`
 *
 * The mission is the most prominent instruction the site gives: one sentence at
 * the top of the Plan page saying what to do about the next 13 weeks. Which
 * instructions it contains, and in what order, is a financial decision, and
 * until this move `public/plan.js` made it where no test could reach it.
 *
 * Three kinds of check, and they prove different things:
 *
 *   1. HAND-COMPUTED STATES. The engine is handed literal facts — a gap of
 *      $1,043.16 that can be covered, a card $612 over its limit, a HELOC that
 *      crosses on 30 April — and the expected instructions are reasoned from
 *      those facts in the comment above each case. Nothing here re-runs the
 *      selection to find out what it should be.
 *   2. MUTATION. Each decision branch is broken on purpose, in the inputs and
 *      in the engine source, and the mission has to change. A branch that
 *      cannot be broken was not being tested.
 *   3. MIGRATION EQUIVALENCE. The exact expression `public/plan.js` used before
 *      this move, run against the real published plan, must still produce the
 *      same sentence — through the page's own wording map and the real
 *      formatters, not through a copy of them. The authority moves; the
 *      household reads the same words.
 */

const fs = require('fs');
// The "never" assertions read every page script, the Stack page included; positive "the classic page reads X" assertions
// stay on plan.js and retire with it (C1 S7, docs/C1_TEST_DISPOSITIONS.md).
const { neverRaw } = require('./lib/page-scripts');
const path = require('path');
const vm = require('vm');
const { sourceText } = require('./test-source-text');
const F = require('../public/forecast.js');
const data = require('../data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const read = p => sourceText(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
const ids = result => result.parts.map(p => p.id).join(' → ');
const part = (result, id) => result.parts.find(p => p.id === id) || null;

/* ------------------------------------------------------------- fixtures */
/* Literal inputs. `advice` is what Forecast.recommend returns and `walk` is
 * what Forecast.projectDebts returns; only the fields the mission reads are
 * given, and every one of them is stated, never derived here. */
const AS_OF = '2026-03-02';

const advice = o => Object.assign({
  weekly: 900,
  gap: null,
  funding: null,
  sim: { min: { date: AS_OF, balance: 1200 }, buffer: 500 },
}, o);

const walk = o => Object.assign({ marks: [], crossings: [] }, o);

// Day 0 of the debt walk: what is over its limit TODAY.
const opening = debts => ({ day: 0, date: AS_OF, debts });
const CARD = (id, label, overLimit) => ({ id, label, overLimit });

const NOTHING_OVER = [
  CARD('cashback', 'TD Cash Back Visa', false),
  CARD('triangle', 'Triangle Mastercard', false),
];
const CASHBACK_OVER = [
  CARD('cashback', 'TD Cash Back Visa', true),
  CARD('triangle', 'Triangle Mastercard', false),
];
const TWO_OVER = [
  CARD('cashback', 'TD Cash Back Visa', true),
  CARD('travelvisa', 'Travel Visa (business)', true),
  CARD('triangle', 'Triangle Mastercard', false),
];
// The HELOC crosses its own limit on 30 April, inside the window, without
// anyone borrowing another dollar.
const HELOC_CROSSES = [{ id: 'heloc', label: 'HELOC', date: '2026-04-30',
  limit: 202654, day: 59, alreadyOver: false }];
// Already over on day 0: a fact about today, not something the window predicts.
const HELOC_ALREADY_OVER = [{ id: 'heloc', label: 'HELOC', date: AS_OF,
  limit: 202654, day: 0, alreadyOver: true }];

console.log('=== 1. a fundable timing gap ===');
/* The household is $1,043.16 short on 12 March before spending anything, and
 * Amanda's account holds enough to cover all of it (shortfall $0, feasible).
 * Nothing is over its limit and the HELOC never crosses.
 *
 * By the stated order: the gap is instruction one; there is no over-limit
 * facility, so nothing follows it; the gap CAN be funded and no weekly figure
 * was overridden, so the household is told to hold the recommended $900; and
 * with no crossing the surplus goes at the most expensive card. */
const fundable = F.mission(
  advice({ weekly: 900,
    gap: { amount: 1043.16, date: '2026-03-12', floor: -543.16, floorDate: '2026-03-12' },
    funding: { shortfall: 0, feasible: true, needsCombination: false } }),
  walk({ marks: [opening(NOTHING_OVER)] }),
  { weeklyOverride: null });
ok(ids(fundable) === 'coverGap → holdSpending → surplusToCard',
  'cover the gap, hold spending, then the surplus at the card', ids(fundable));
ok(!part(fundable, 'nearBoundary'),
  'fixtures without a recommend.nearBoundary list do not invent one');
ok(part(fundable, 'coverGap').amount === 1043.16
  && part(fundable, 'coverGap').by === '2026-03-12',
  'the gap instruction carries $1,043.16 by 12 March',
  JSON.stringify(part(fundable, 'coverGap')));
ok(part(fundable, 'holdSpending').weekly === 900,
  'and the weekly figure is the recommended $900');

console.log('\n=== 2 + 5. an unfundable gap: no spending instruction at all ===');
/* The same household at a buffer it cannot reach: the gap is $5,543.16 and
 * every usable source combined leaves $1,783.47 unfunded. The Cash Back Visa
 * is over its limit today, and the HELOC crosses on 30 April.
 *
 * Spending is not a remedy for money that does not exist — at any weekly
 * figure, including $0, the floor stays under the buffer — so the mission must
 * name the shortfall and then say NOTHING about weekly spending. The mission
 * once recommended $1,500/week against a −$809 low because only the status band
 * had been conditioned on this. */
const unfundable = F.mission(
  advice({ weekly: 0,
    gap: { amount: 5543.16, date: '2026-03-12', floor: -5043.16, floorDate: '2026-03-12' },
    funding: { shortfall: 1783.47, feasible: false, needsCombination: true },
    sim: { min: { date: '2026-03-12', balance: -1283.47 }, buffer: 5000 } }),
  walk({ marks: [opening(CASHBACK_OVER)], crossings: HELOC_CROSSES }),
  { weeklyOverride: null });
ok(ids(unfundable) === 'fundingShortfall → overLimit → helocLimit',
  'find the shortfall, fix the over-limit card, stop the HELOC growing',
  ids(unfundable));
ok(part(unfundable, 'fundingShortfall').shortfall === 1783.47,
  'the unfunded $1,783.47 is what the household is sent to find');
ok(!part(unfundable, 'holdSpending') && !part(unfundable, 'cutSpending'),
  'and NO weekly spending instruction is given, at any figure');

console.log('\n=== 3. debt over its limit today ===');
/* No gap. Two cards are over their limits today and a third is not. The window
 * predicts no HELOC crossing.
 *
 * Both over-limit facilities are named, in the walk's own order, and the card
 * that is inside its limit is not. */
const overLimit = F.mission(
  advice({ weekly: 1300 }),
  walk({ marks: [opening(TWO_OVER)] }),
  { weeklyOverride: null });
ok(ids(overLimit) === 'overLimit → holdSpending → surplusToCard',
  'with no gap the over-limit instruction opens the mission', ids(overLimit));
ok(part(overLimit, 'overLimit').debts.map(d => d.label).join(' and ')
  === 'TD Cash Back Visa and Travel Visa (business)',
  'both over-limit facilities are named, in the walk order',
  part(overLimit, 'overLimit').debts.map(d => d.label).join(' and '));
ok(!part(overLimit, 'overLimit').debts.some(d => d.id === 'triangle'),
  'and the facility inside its limit is not named');

console.log('\n=== 4. a supported weekly figure, and one that is not ===');
/* The forecast supports $1,250/week. The household has typed $1,500, and the
 * projection at $1,500 reaches −$809.12 against a $500 buffer.
 *
 * The instruction is to CUT to the figure the forecast supports, and it names
 * the figure that fails, because "hold spending to $1,500" would be telling the
 * household to do the thing that breaks the plan. */
const breaching = F.mission(
  advice({ weekly: 1250,
    gap: { amount: 1043.16, date: '2026-03-12' },
    funding: { shortfall: 0, feasible: true },
    sim: { min: { date: '2026-05-01', balance: -809.12 }, buffer: 500 } }),
  walk({ marks: [opening(NOTHING_OVER)] }),
  { weeklyOverride: 1500,
    sim: { min: { date: '2026-05-01', balance: -809.12 }, buffer: 500 } });
ok(!!part(breaching, 'cutSpending'), 'an override that breaches becomes "cut", not "hold"',
  ids(breaching));
ok(part(breaching, 'cutSpending').supported === 1250
  && part(breaching, 'cutSpending').unsupported === 1500,
  'cut to the supported $1,250; the $1,500 that does not hold is named',
  JSON.stringify(part(breaching, 'cutSpending')));

/* The same override, on a projection that stays above the buffer: $1,000/week
 * with a $640 low against a $500 buffer holds, so the household is told to hold
 * ITS OWN figure. Setting a weekly figure is not by itself a breach. */
const holdingOverride = F.mission(
  advice({ weekly: 1250, sim: { min: { date: '2026-05-01', balance: 640 }, buffer: 500 } }),
  walk({ marks: [opening(NOTHING_OVER)] }),
  { weeklyOverride: 1000,
    sim: { min: { date: '2026-05-01', balance: 640 }, buffer: 500 } });
ok(!!part(holdingOverride, 'holdSpending')
  && part(holdingOverride, 'holdSpending').weekly === 1000,
  'an override that holds is instructed at the household\'s own $1,000',
  ids(holdingOverride));

/* The buffer tolerance is $0.005, and it is stated rather than incidental: a
 * low of $499.996 is the buffer, and $499.99 is below it. */
const atBuffer = w => F.mission(
  advice({ weekly: 1250, sim: { min: { date: '2026-05-01', balance: w }, buffer: 500 } }),
  walk({ marks: [opening(NOTHING_OVER)] }),
  { weeklyOverride: 1000, sim: { min: { date: '2026-05-01', balance: w }, buffer: 500 } });
ok(!!part(atBuffer(499.996), 'holdSpending'),
  'a low within half a cent of the buffer is not a breach');
ok(!!part(atBuffer(499.99), 'cutSpending'),
  'and a low a cent under it is');

console.log('\n=== 6 + 7. the HELOC crossing, and when there is none ===');
/* Identical households, differing in one fact: whether the HELOC crosses its
 * own limit inside the window. */
const crossing = F.mission(
  advice({ weekly: 1250 }),
  walk({ marks: [opening(NOTHING_OVER)], crossings: HELOC_CROSSES }),
  { weeklyOverride: null });
ok(part(crossing, 'helocLimit') && part(crossing, 'helocLimit').date === '2026-04-30',
  'a future crossing is instructed on the day it actually happens',
  JSON.stringify(part(crossing, 'helocLimit')));
ok(!part(crossing, 'surplusToCard'),
  'and the surplus instruction gives way to it');

const noCrossing = F.mission(
  advice({ weekly: 1250 }),
  walk({ marks: [opening(NOTHING_OVER)], crossings: [] }),
  { weeklyOverride: null });
ok(!!part(noCrossing, 'surplusToCard') && !part(noCrossing, 'helocLimit'),
  'with no crossing the surplus goes at the most expensive card', ids(noCrossing));

/* A HELOC already over its limit on day 0 is not a crossing the window
 * predicts — it is today's over-limit fact, and it is named as one. */
const alreadyOver = F.mission(
  advice({ weekly: 1250 }),
  walk({ marks: [opening([CARD('heloc', 'HELOC', true)])], crossings: HELOC_ALREADY_OVER }),
  { weeklyOverride: null });
ok(ids(alreadyOver) === 'overLimit → holdSpending → surplusToCard',
  'a HELOC already over its limit is an over-limit instruction, not a crossing',
  ids(alreadyOver));

console.log('\n=== mutation: each branch is load-bearing ===');
/* Change ONE input fact and the mission has to change. If it does not, the
 * branch was decorative. */
const fundableAdvice = advice({ weekly: 900,
  gap: { amount: 1043.16, date: '2026-03-12' },
  funding: { shortfall: 0, feasible: true } });

// Make the same gap unfundable: the instruction flips and spending disappears.
const madeUnfundable = F.mission(
  Object.assign({}, fundableAdvice,
    { funding: { shortfall: 500, feasible: false } }),
  walk({ marks: [opening(NOTHING_OVER)] }), { weeklyOverride: null });
ok(ids(madeUnfundable) === 'fundingShortfall → surplusToCard',
  'making the gap unfundable removes the spending instruction',
  ids(madeUnfundable));

// Put a card over its limit: the instruction appears, between gap and spending.
const gainedOverLimit = F.mission(fundableAdvice,
  walk({ marks: [opening(CASHBACK_OVER)] }), { weeklyOverride: null });
ok(ids(gainedOverLimit) === 'coverGap → overLimit → holdSpending → surplusToCard',
  'an over-limit card is instructed after the gap and before spending',
  ids(gainedOverLimit));

// Remove the gap: the household is not told to cover one.
const noGap = F.mission(advice({ weekly: 900 }),
  walk({ marks: [opening(NOTHING_OVER)] }), { weeklyOverride: null });
ok(ids(noGap) === 'holdSpending → surplusToCard',
  'with no gap there is no gap instruction', ids(noGap));

// Over its limit today, but not at day 90: "today" is the fact being reported.
const laterMark = F.mission(advice({ weekly: 900 }),
  walk({ marks: [opening(CASHBACK_OVER),
    { day: 90, date: '2026-05-31', debts: NOTHING_OVER }] }),
  { weeklyOverride: null });
ok(ids(laterMark) === 'overLimit → holdSpending → surplusToCard',
  'the opening mark decides the over-limit instruction, not a later one',
  ids(laterMark));

console.log('\n=== near-boundary obligations precede surplus-use guidance ===');
/* Literal recommend.nearBoundary, as Forecast.recommend now attaches from
 * existing events. The mission must name it before the surplus instruction
 * and must not choose the window or re-sum the items. */
const withBoundary = F.mission(
  advice({ weekly: 900, nearBoundary: {
    payday: '2026-03-06', until: '2026-03-07', total: 900,
    items: [{ date: '2026-03-07', id: 'hydro', label: 'Hydro', kind: 'bill', amount: 900 }],
  } }),
  walk({ marks: [opening(NOTHING_OVER)] }),
  { weeklyOverride: null });
ok(ids(withBoundary) === 'holdSpending → nearBoundary → surplusToCard',
  'named near-boundary obligations sit before surplus-to-card',
  ids(withBoundary));
ok(part(withBoundary, 'nearBoundary').total === 900
  && part(withBoundary, 'nearBoundary').payday === '2026-03-06'
  && part(withBoundary, 'nearBoundary').count === 1
  && part(withBoundary, 'nearBoundary').items
  && part(withBoundary, 'nearBoundary').items[0].label === 'Hydro',
  'the part carries the recommend total, payday, count and item names');

const boundaryAndHeloc = F.mission(
  advice({ weekly: 900, nearBoundary: {
    payday: '2026-03-06', until: '2026-03-07', total: 900,
    items: [{ date: '2026-03-07', id: 'hydro', label: 'Hydro', kind: 'bill', amount: 900 }],
  } }),
  walk({ marks: [opening(NOTHING_OVER)], crossings: HELOC_CROSSES }),
  { weeklyOverride: null });
ok(ids(boundaryAndHeloc) === 'holdSpending → nearBoundary → helocLimit',
  'they also sit before a HELOC-crossing surplus instruction',
  ids(boundaryAndHeloc));

const emptyBoundary = F.mission(
  advice({ weekly: 900, nearBoundary: { payday: '2026-03-06', until: '2026-03-07', items: [], total: 0 } }),
  walk({ marks: [opening(NOTHING_OVER)] }),
  { weeklyOverride: null });
ok(ids(emptyBoundary) === 'holdSpending → surplusToCard',
  'an empty list does not insert a vacant instruction', ids(emptyBoundary));

console.log('\n=== infeasible: the zero-spend sentinel is not a spending instruction ===');
/* Recommend has already decided the protected plan cannot work. weekly = 0 is
 * the failure sentinel, not a feasible cap. The status band copies that
 * infeasible record; the mission must not then tell the household to hold
 * $0/week and put a surplus against the card. Figures are copied from
 * advice.infeasible — nothing here re-derives the shortfall. */
const infeasibleAdvice = advice({
  mode: 'infeasible',
  weekly: 0,
  infeasible: {
    kind: 'encumbered', date: '2026-11-07', shortfall: 1200,
    label: 'Christmas 2026',
  },
});
const infeasible = F.mission(
  infeasibleAdvice,
  walk({ marks: [opening(NOTHING_OVER)] }),
  { weeklyOverride: null });
ok(ids(infeasible) === 'infeasible',
  'an infeasible recommend result is the mission outcome, not holdSpending',
  ids(infeasible));
ok(part(infeasible, 'infeasible').shortfall === 1200
  && part(infeasible, 'infeasible').label === 'Christmas 2026'
  && part(infeasible, 'infeasible').date === '2026-11-07'
  && part(infeasible, 'infeasible').kind === 'encumbered',
  'and copies the first failing constraint from advice.infeasible',
  JSON.stringify(part(infeasible, 'infeasible')));
ok(!part(infeasible, 'holdSpending') && !part(infeasible, 'cutSpending')
  && !part(infeasible, 'surplusToCard'),
  'and emits no weekly spending or surplus-use instruction');

console.log('\n=== mutation: breaking the engine breaks the answer ===');
/* The strongest form available here: mutate the engine source, load the mutant,
 * and require it to disagree with the real engine on a case above. A guard that
 * still passes when the code it guards is removed is not a guard. */
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
const MUTATIONS = [
  { label: 'dropping the "cannot be funded" guard instructs spending anyway',
    from: '    if (!fundingShort) {',
    to: '    if (true) {',
    check: m => {
      const out = m.mission(
        advice({ weekly: 0,
          gap: { amount: 5543.16, date: '2026-03-12' },
          funding: { shortfall: 1783.47, feasible: false } }),
        walk({ marks: [opening(NOTHING_OVER)] }), { weeklyOverride: null });
      return !!part(out, 'holdSpending');
    },
    real: () => !part(unfundable, 'holdSpending') && !part(unfundable, 'cutSpending') },

  { label: 'dropping the already-over filter instructs a crossing that already happened',
    from: "      .find(c => c.id === 'heloc' && !c.alreadyOver) || null;",
    to: "      .find(c => c.id === 'heloc') || null;",
    check: m => {
      const out = m.mission(advice({ weekly: 1250 }),
        walk({ marks: [opening([CARD('heloc', 'HELOC', true)])], crossings: HELOC_ALREADY_OVER }),
        { weeklyOverride: null });
      return !!part(out, 'helocLimit');
    },
    real: () => !part(alreadyOver, 'helocLimit') },

  // The predicate now lives in `planContext`, which the mission and the status
  // band both consume — so this mutation breaks one line and both verdicts,
  // which is exactly why there is one line.
  { label: 'dropping the override-breach test instructs the figure that does not hold',
    from: '      overrideBreaches: override != null && !!sim && below(sim.min.balance, sim.buffer),',
    to: '      overrideBreaches: false,',
    check: m => {
      const out = m.mission(
        advice({ weekly: 1250, sim: { min: { date: '2026-05-01', balance: -809.12 }, buffer: 500 } }),
        walk({ marks: [opening(NOTHING_OVER)] }),
        { weeklyOverride: 1500,
          sim: { min: { date: '2026-05-01', balance: -809.12 }, buffer: 500 } });
      return !!part(out, 'holdSpending') && part(out, 'holdSpending').weekly === 1500;
    },
    real: () => !!part(breaching, 'cutSpending') },

  { label: 'dropping the infeasible guard instructs $0/week as if the plan held',
    from: '    if (advice.infeasible && advice.mode === \'infeasible\') {',
    to: '    if (false && advice.infeasible && advice.mode === \'infeasible\') {',
    check: m => {
      const out = m.mission(infeasibleAdvice,
        walk({ marks: [opening(NOTHING_OVER)] }), { weeklyOverride: null });
      return !!part(out, 'holdSpending') && part(out, 'holdSpending').weekly === 0
        && !!part(out, 'surplusToCard');
    },
    real: () => ids(infeasible) === 'infeasible'
      && !part(infeasible, 'holdSpending') && !part(infeasible, 'surplusToCard') },

  { label: 'reading a later mark loses an over-limit facility that is over today',
    from: '    const opening = ((debtProj && debtProj.marks) || []).find(m => m.day === 0);',
    to: '    const opening = ((debtProj && debtProj.marks) || []).find(m => m.day === 90);',
    check: m => {
      const out = m.mission(advice({ weekly: 900 }),
        walk({ marks: [opening(CASHBACK_OVER),
          { day: 90, date: '2026-05-31', debts: NOTHING_OVER }] }),
        { weeklyOverride: null });
      return !part(out, 'overLimit');
    },
    real: () => !!part(laterMark, 'overLimit') },
];
for (const m of MUTATIONS) {
  const built = mutant(m.from, m.to);
  if (built.error) { ok(false, m.label, built.error); continue; }
  ok(m.check(built.engine) && m.real(), m.label);
}

console.log('\n=== the page renders, and has words for every instruction ===');
/* The page's wording map, and the real formatters it uses, lifted from the
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
  grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong()'),
  grab(planSrc, /^const fmtMonth = .*$/m, 'fmtMonth()'),
].join('\n');
const MAP_SRC = grab(planSrc, /^const MISSION_PART = \{[\s\S]*?^\};$/m, 'the wording map');
const MISSION_PART = vm.runInNewContext(`${FORMATTERS}\n${MAP_SRC}\nMISSION_PART;`);
const render = result => result.parts.map(p => MISSION_PART[p.id](p)).join(', ')
  .replace(/^./, c => c.toUpperCase()) + '.';

// Every instruction the engine can emit has wording, and every wording is
// reachable. Either gap is a household-visible failure: a missing entry throws
// on the page, and an unreachable one is dead prose that looks maintained.
const missionSrc = /\n  function mission\(advice, debtProj, opts\) \{[\s\S]*?\n  \}\n/.exec(FORECAST_SRC);
ok(!!missionSrc, 'the mission function is readable from forecast.js');
const engineIds = [...new Set([...(missionSrc ? missionSrc[0] : '')
  .matchAll(/\bid: '([A-Za-z]+)'/g)].map(m => m[1]))].sort();
const wordedIds = Object.keys(MISSION_PART).sort();
ok(engineIds.length === 9, 'the engine emits nine instructions', engineIds.join(', '));
ok(engineIds.every(id => wordedIds.includes(id)),
  'the page has wording for every instruction the engine can emit',
  engineIds.filter(id => !wordedIds.includes(id)).join(', ') || 'none missing');
ok(wordedIds.every(id => engineIds.includes(id)),
  'and no wording is left behind for an instruction the engine cannot emit',
  wordedIds.filter(id => !engineIds.includes(id)).join(', ') || 'none stale');

// The page no longer decides. These are the exact expressions it used.
ok(/Forecast\.mission\(/.test(planSrc), 'the Plan page reads the mission from Forecast');
ok(neverRaw(/missionParts/).length === 0,
  'and assembles no mission parts of its own');
ok(neverRaw(/if \(gap && fundingShort\) \{\s*\n\s*missionParts/).length === 0,
  'it does not choose between covering a gap and reporting a shortfall');
ok(neverRaw(/if \(!fundingShort\) \{\s*\n\s*missionParts/).length === 0,
  'it does not decide whether a spending instruction applies');
ok(neverRaw(/missionParts\.push\(helocBreach/, /if \(helocBreach\) missionParts/).length === 0,
  'and it does not choose between the HELOC crossing and the surplus');

console.log('\n=== migration equivalence on the real published plan ===');
/* The mission the household reads today, both ways. `legacy` is the expression
 * public/plan.js ran before this move, character for character; `moved` is the
 * engine's decision rendered through the page's wording map. Three real
 * settings, so the equivalence covers more than the one branch that happens to
 * be live: the published default, a weekly override that breaches, and a buffer
 * no source can reach. */
const plan = data.plan, asOf = data.meta.asOf;
const [money, money2, fmtDateLong, fmtMonth] = vm.runInNewContext(
  `${FORMATTERS}\n[money, money2, fmtDateLong, fmtMonth];`);

function published({ targetBuffer, weeklyVariable }) {
  const base = { scenario: plan.defaults.scenario, targetBuffer,
    extraDebtMonthly: plan.defaults.extraDebtMonthly, incomeOverrides: {},
    disabled: [], debts: data.debts, extraDebtTarget: plan.nextDollar.target };
  const adv = F.recommend(plan, asOf,
    Object.assign({}, base, { fundingSources: plan.funding && plan.funding.options }));
  const weekly = weeklyVariable != null ? weeklyVariable : adv.weekly;
  const sim = weekly === adv.weekly ? adv.sim
    : F.simulate(plan, asOf, Object.assign({}, adv.simOptions, { weeklyVariable: weekly }));
  const debtProj = F.projectDebts(plan, data.debts, asOf,
    Object.assign({}, adv.simOptions, { weeklyVariable: weekly,
      extraFacilities: data.revolvingExtra, extraDebtTarget: plan.nextDollar.target }));
  return { adv, sim, weekly, debtProj, weeklyVariable };
}

function legacySentence({ adv, sim, weekly, debtProj, weeklyVariable }) {
  // Copied from public/plan.js as it stood at a558c5c, unchanged.
  const fundingPlan = adv.funding || null;
  const fundingShort = !!(fundingPlan && !fundingPlan.feasible);
  const recommended = adv.weekly;
  const gap = adv.gap;
  const fundingGap = gap ? gap.amount : 0;
  const overrideBreaches = weeklyVariable != null && sim.min.balance < sim.buffer - 0.005;
  const mark = n => debtProj.marks.find(m => m.day === n) || debtProj.marks[debtProj.marks.length - 1];
  const today = mark(0);
  const overToday = today.debts.filter(x => x.overLimit);
  const helocBreach = (debtProj.crossings || [])
    .find(c => c.id === 'heloc' && !c.alreadyOver) || null;
  const missionParts = [];
  if (gap && fundingShort) {
    missionParts.push(`find ${money(fundingPlan.shortfall)} beyond every account available, or lower the buffer`);
  } else if (gap) {
    missionParts.push(`cover the ${money(fundingGap)} timing gap by ${fmtDateLong(gap.date)}`);
  }
  if (overToday.length) missionParts.push(`get the ${overToday.map(x => x.label).join(' and ')} back under its limit`);
  if (!fundingShort) {
    missionParts.push(overrideBreaches
      ? `cut spending to ${money(recommended)} a week — ${money(weekly)} does not hold`
      : `hold spending to ${money(weekly)} a week`);
  }
  const nb = adv.nearBoundary;
  if (nb && nb.items && nb.items.length) {
    missionParts.push(`and ${money2(nb.total)} of named obligations (${nb.items.map(x => x.label).join(', ')}) fall on or immediately after the next payday (${fmtDateLong(nb.payday)})`);
  }
  if (helocBreach) missionParts.push(`and stop the HELOC growing before it passes its own limit in ${fmtMonth(helocBreach.date)}`);
  else missionParts.push('and put the surplus against the most expensive card');
  return missionParts.join(', ').replace(/^./, c => c.toUpperCase()) + '.';
}

const SETTINGS = [
  { what: 'the published default — $500 buffer, no override',
    targetBuffer: plan.defaults.targetBuffer, weeklyVariable: null,
    expect: /hold spending to .* a week, and .* of named obligations .* fall on or immediately after the next payday/ },
  { what: 'a $1,500/week override the forecast does not support',
    targetBuffer: plan.defaults.targetBuffer, weeklyVariable: 1500,
    expect: /cut spending to .* a week — .* does not hold/ },
  { what: 'a $5,000 buffer no combination of sources can reach',
    targetBuffer: 5000, weeklyVariable: null,
    expect: /Cover the .* timing gap by .*|Find .* beyond every account available, or lower the buffer/ },
];
for (const s of SETTINGS) {
  const inputs = published(s);
  const legacy = legacySentence(inputs);
  const moved = render(F.mission(inputs.adv, inputs.debtProj,
    { weeklyOverride: s.weeklyVariable, sim: inputs.sim }));
  ok(legacy === moved, `identical sentence — ${s.what}`,
    legacy === moved ? moved : `\n      old: ${legacy}\n      new: ${moved}`);
  ok(s.expect.test(moved), `and it takes the expected branch, not an empty one — ${s.what}`,
    s.expect.test(moved) ? '' : moved);
}

// The spending instruction really is absent on the real plan at that buffer —
// asserted on the published data, not only on a fixture.
const unreachable = published({ targetBuffer: 5000, weeklyVariable: null });
const unreachableMission = F.mission(unreachable.adv, unreachable.debtProj,
  { weeklyOverride: null, sim: unreachable.sim });
ok(part(unreachableMission, 'fundingShortfall')
  ? !part(unreachableMission, 'holdSpending') && !part(unreachableMission, 'cutSpending')
  : !!(part(unreachableMission, 'coverGap') || part(unreachableMission, 'holdSpending')),
  'an unreachable buffer either funds a gap or withholds a weekly figure; $600 is not policy',
  ids(unreachableMission));

const liveDefault = published({
  targetBuffer: plan.defaults.targetBuffer, weeklyVariable: null,
});
const liveSentence = render(F.mission(liveDefault.adv, liveDefault.debtProj,
  { weeklyOverride: null, sim: liveDefault.sim }));
const liveNames = (liveDefault.adv.nearBoundary.items || []).map(i => i.label);
ok(liveNames.length >= 1 && liveNames.every(name => liveSentence.includes(name)),
  'the live Plan sentence names every near-boundary obligation',
  liveNames.filter(name => !liveSentence.includes(name)).join(', ') || liveSentence);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
