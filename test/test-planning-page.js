'use strict';
/* Planning page — "What are we preparing and saving for?" `node test/test-planning-page.js`
 *
 * The page renders Forecast.majorPlans (plus the matching
 * Forecast.paydayAllocation row) from the same Forecast.recommend call the
 * Plan page and the assistant packet use. This suite runs the real
 * planning.js in a vm with the real app.js formatters and a stub App, and
 * reads the HTML the household would read. Behaviour uses a synthetic
 * fixture whose verdicts and amounts are forced by construction; the live
 * data.json proves the settled-row exclusion and field pass-through against
 * Forecast's own output. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const periods = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/periods.json'), 'utf8'));

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const money2 = n => (n < 0 ? '−$' : '$') + Math.abs(Number(n)).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const longDate = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-CA', { day: 'numeric', month: 'long', year: 'numeric' });
const strip = html => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ---------------------------------------------------------------- harness */
function loadPage(script) {
  const appSrc = read('public/app.js');
  const grab = re => { const m = re.exec(appSrc); if (!m) throw new Error('missing ' + re); return m[0]; };
  const helpers = [
    grab(/^const money = .*$/m), grab(/^const money2 = .*$/m), grab(/^const pct = .*$/m),
    grab(/^const fmtDate = .*$/m), grab(/^const fmtDateLong = .*$/m), grab(/^const fmtDateFull = .*$/m),
  ].join('\n');
  const elements = {};
  const ctx = {
    Forecast: F, console, elements,
    App: { hooks: [], bootOpts: null, register(fn) { this.hooks.push(fn); }, boot(opts) { this.bootOpts = opts || {}; } },
  };
  vm.runInNewContext(
    `${helpers}\nfunction planningStubEl(){ const attrs = {}; return { innerHTML: '', textContent: '', querySelector(){return null;}, querySelectorAll(){return [];}, classList:{toggle(){},add(){},remove(){}}, setAttribute(k,v){ attrs[k]=v; }, getAttribute(k){ return attrs[k] != null ? attrs[k] : null; } }; }\nconst $ = id => elements[id] || (elements[id] = planningStubEl());\n${read(script)}`,
    ctx, { filename: script });
  const pageApi = {
    ctx,
    render(data, p) {
      for (const k of Object.keys(elements)) delete elements[k];
      for (const fn of ctx.App.hooks) fn(data, p || null, null);
      return elements;
    },
    // The same composer the page runs, on an advice object the test controls.
    compose(advice, liveOverlay) { return ctx.planningPageHtml(advice, liveOverlay); },
    composeTrajectory(data, p) {
      return ctx.planningTrajectoryHtml(ctx.planningTrajectory(data, p || null));
    },
    composePressure(data, p) {
      return ctx.planningTrajectoryPressureHtml(ctx.planningTrajectory(data, p || null));
    },
    composeDebtDirection(data, p) {
      return ctx.planningTrajectoryDebtDirectionHtml(ctx.planningTrajectory(data, p || null));
    },
    composeFunding(data, p, granularity, periodKey) {
      return ctx.planningTrajectoryFundingHtml(
        ctx.planningTrajectory(data, p || null), granularity || 'month', periodKey);
    },
    composeRoadAhead(data, p, granularity, periodKey, asOf) {
      return ctx.planningRoadAheadHtml(
        ctx.planningTrajectory(data, p || null),
        granularity || 'month',
        periodKey,
        asOf || (data && data.meta && data.meta.asOf) || null,
      );
    },
    composeRoadAheadTraj(traj, granularity, periodKey, asOf) {
      return ctx.planningRoadAheadHtml(
        traj,
        granularity || 'month',
        periodKey,
        asOf || null,
      );
    },
    composeScenario(data, p, debtId, amount) {
      const requested = debtId != null && amount != null;
      const input = requested
        ? { debtId, amount, nature: 'additional-debt-payment' }
        : null;
      const result = input
        ? ctx.planningTrajectoryScenario(data, p || null, input)
        : null;
      return ctx.planningTrajectoryScenarioCompareHtml(result, requested);
    },
    applyScenarioAndRender(data, p, debtId, amount) {
      ctx.planningScenarioSetActive(debtId != null && amount != null ? { debtId, amount } : null);
      return pageApi.render(data, p);
    },
    clearScenarioAndRender(data, p) {
      ctx.planningScenarioSetActive(null);
      ctx.planningScenarioDraftDebtId = '';
      ctx.planningScenarioDraftAmount = '';
      ctx.planningScenarioFormError = '';
      ctx.planningScenarioDrawerOpen = true;
      return pageApi.render(data, p);
    },
    composeScenarioSection(data, p) {
      return ctx.planningRoadAheadScenarioHtml(data, p || null);
    },
  };
  return pageApi;
}

function row(html, id) {
  const re = new RegExp(`<article class="planning-row[^"]*" data-planning-id="${id}"[\\s\\S]*?<\\/article>`);
  const m = re.exec(html);
  return m ? m[0] : null;
}
function factOf(rowHtml, name) {
  const re = new RegExp(`<div data-planning-fact="${name}">[\\s\\S]*?<\\/div>`);
  const m = re.exec(rowHtml || '');
  return m ? m[0] : null;
}
const ids = html => [...String(html || '').matchAll(/data-planning-id="([^"]+)"/g)].map(m => m[1]);

/* ---------------------------------------------------------------- fixture */
// Plenty of cash so every verdict is ON TRACK by construction, except a
// dated point cost placed beyond the cash on hand before payday.
const AS_OF = '2026-03-10';
function fixture(cashValue) {
  return {
    meta: { asOf: AS_OF },
    revolvingExtra: [],
    debts: [],
    plan: {
      windowDays: 91,
      defaults: { scenario: 'expected', targetBuffer: 0, extraDebtMonthly: 0 },
      opening: { asOf: AS_OF },
      startingCash: { breakdown: [{ id: 'chequing-a', label: 'Chequing A', value: cashValue == null ? 50000 : cashValue }] },
      income: [{ id: 'pay', label: 'Pay', frequency: 'biweekly', anchor: '2026-03-06', amount: 2000, confidence: 'confirmed' }],
      obligations: [],
      bills: [],
      commitments: [
        { id: 'settled-camp', date: '2026-03-01', label: 'Settled camp', amount: 786, confidence: 'confirmed', settledOn: '2026-03-02' },
        { id: 'dated-point', date: '2026-04-10', label: 'Dated point cost', amount: 800, confidence: 'estimated', adjustable: true },
        { id: 'point', label: 'Point estimate', amount: 2000, when: 'late Sep 2026', confidence: 'estimated' },
        { id: 'range', label: 'Range cost', amount: null, amountMin: 700, amountMax: 1200, when: 'Fall 2026', confidence: 'estimated', adjustable: true },
        { id: 'tbd', label: 'Timing TBD cost', amount: 1000, when: 'timing TBD', confidence: 'estimated' },
        { id: 'optional', label: 'Optional wish', amount: 300, when: 'someday', confidence: 'estimated', optional: true },
      ],
    },
  };
}

const page = loadPage('public/planning.js');

const LEFTOVER_ROAD_DRAWER = /Pressure signals on this (month|pay period)|What-if: extra payment|Known future costs Atlas is protecting|Monthly cash and debt \(detailed\)|Three-stage funding \(expanded picker\)|All pressure signals in this projection|Debt direction across the projection/;
const REMOVED_SHELL_IDS = [
  'planning-lede', 'planning-list', 'planning-note',
  'planning-trajectory-lede', 'planning-trajectory', 'planning-trajectory-note',
  'planning-trajectory-funding-lede', 'planning-trajectory-funding-picker',
  'planning-trajectory-funding', 'planning-trajectory-funding-note',
  'planning-trajectory-pressure-lede', 'planning-trajectory-pressure',
  'planning-trajectory-pressure-note',
  'planning-trajectory-debt-direction-lede', 'planning-trajectory-debt-direction',
  'planning-trajectory-debt-direction-note',
];

function adviceFrom(data, p) {
  return F.recommend(data.plan, data.meta.asOf, {
    fundingSources: data.plan && data.plan.funding && data.plan.funding.options,
    debts: data.debts || [],
    extraFacilities: data.revolvingExtra || [],
    periods: p || null,
  });
}
function pageList(data, p) {
  return page.compose(adviceFrom(data, p), data.liveOverlay || null);
}

console.log('=== 1–2. The page consumes Forecast.majorPlans and invents no verdict ===');
{
  const src = stripComments(read('public/planning.js'));
  ok(/Forecast\.recommend\(/.test(src) && /advice\.majorPlans/.test(src) && /advice\.paydayAllocation/.test(src),
    'planning.js reads majorPlans and paydayAllocation off Forecast.recommend');
  ok(!/plan\.commitments/.test(src), 'planning.js never reads plan.commitments');
  ok(!/Forecast\.(fundingSequence|majorPlans|simulate|expandEvents)\(/.test(src),
    'planning.js does not call the sequence or walk itself — one recommend call, like Plan and the assistant packet');
  const verdictAssign = /verdict\s*=\s*['"](ON TRACK|AT RISK|FUNDING GAP)['"]/.test(src)
    || /['"](ON TRACK|AT RISK|FUNDING GAP)['"]\s*:\s*\(?\s*\w*\s*(>|<|>=|<=|-|\+)/.test(src);
  ok(!verdictAssign, 'no verdict is computed in the page; the three strings appear only as presentation keys');
  ok(!/remaining\s*[-+*/]=|\.need\s*[-+*/]|\.amountMin\s*[-+*/]|\.amountMax\s*[-+*/]|\/\s*2/.test(src),
    'no arithmetic on need, remaining or range bounds (no midpoint, no total)');
  ok(!/new Date\(\)|Date\.now|localStorage/.test(src), 'no browser clock and no persisted knob');
  const fx = fixture();
  const composed = pageList(fx, null);
  const advice = adviceFrom(fx, null);
  const rendered = ids(composed.list);
  ok(JSON.stringify(rendered) === JSON.stringify(advice.majorPlans.map(p => p.id)),
    'rows are exactly Forecast.majorPlans, in Forecast order', rendered.join(','));
  for (const p of advice.majorPlans) {
    ok(p.verdict == null ? /Verdict unavailable/.test(row(composed.list, p.id))
      : new RegExp(`data-planning-verdict="${p.verdict}"`).test(row(composed.list, p.id)),
      `${p.id} prints Forecast's verdict ${p.verdict}`);
  }
}

console.log('\n=== 3–4. Unsettled plans render; settled commitments are not savings goals ===');
{
  const html = pageList(fixture(), null).list;
  ok(['dated-point', 'point', 'range', 'tbd', 'optional'].every(id => row(html, id)), 'every unsettled row renders');
  ok(!row(html, 'settled-camp') && !/Settled camp/.test(html), 'a settledOn ≤ as-of commitment does not appear');
  const later = fixture();
  later.plan.commitments.find(c => c.id === 'settled-camp').settledOn = '2026-03-20';
  const laterHtml = pageList(later, null).list;
  ok(!!row(laterHtml, 'settled-camp'), 'a commitment settled after as-of is still unsettled on this opening and renders (Forecast rule, not a page rule)');
  const liveHtml = pageList(live, periods).list;
  const settled = live.plan.commitments.filter(c => F.commitmentSettledBy(c, live.meta.asOf));
  ok(settled.length > 0 && settled.every(c => !row(liveHtml, c.id) && !liveHtml.includes(c.label)),
    `live: ${settled.length} settled commitments (${settled.map(c => c.id).join(', ')}) are absent`);
  const unsettled = live.plan.commitments.filter(c => !F.commitmentSettledBy(c, live.meta.asOf));
  ok(unsettled.every(c => !!row(liveHtml, c.id)), `live: all ${unsettled.length} unsettled commitments render`);
}

console.log('\n=== 5–8. Points stay points, ranges stay ranges, approximate stays approximate, unknown stays unresolved ===');
{
  const html = pageList(fixture(), null).list;
  const point = row(html, 'point');
  ok(/data-planning-amount="point"/.test(point) && strip(factOf(point, 'requirement')).includes('$2,000.00 Cost'),
    'a point estimate prints as one amount');
  const range = row(html, 'range');
  ok(/data-planning-amount="range"/.test(range) && /\$700\.00–\$1,200\.00/.test(range) && /Cost range/.test(range),
    'a range prints as $700.00–$1,200.00');
  ok(!/\$950/.test(range) && !/\$700\.00 Cost </.test(strip(range)), 'no midpoint ($950) and no floor stand-in is printed for the range');
  ok(/data-planning-timing="approximate"/.test(point) && /<span data-planning-when>late Sep 2026<\/span>/.test(point),
    '"late Sep 2026" is printed as stated');
  ok(/<span data-planning-when>Fall 2026<\/span>/.test(range), '"Fall 2026" is printed as stated');
  ok(!/September|October|November|\d{1,2} (Sep|Oct|Nov)/.test(strip(point) + strip(range)),
    'no calendar day is invented from approximate timing');
  const tbd = row(html, 'tbd');
  ok(/<span data-planning-when>timing TBD<\/span>/.test(tbd) && /EXACT DATE UNRESOLVED/.test(tbd),
    '"timing TBD" stays unresolved and is flagged EXACT DATE UNRESOLVED');
  const dated = row(html, 'dated-point');
  ok(/data-planning-timing="dated"/.test(dated) && strip(dated).includes(longDate('2026-04-10')),
    'a dated commitment prints its Forecast date');
  const fxAdvice = F.recommend(fixture().plan, AS_OF, { fundingSources: null, debts: [], extraFacilities: [], periods: null });
  ok(fxAdvice.majorPlans.every(p => /MAY MOVE/.test(row(html, p.id)) === !!p.deferred),
    'MAY MOVE appears exactly where Forecast marked the row deferred');
  ok(/>FLEXIBLE</.test(range) && />REQUIRED</.test(point) && />OPTIONAL</.test(row(html, 'optional')),
    'flexibility chips follow Forecast flexibility');
  // Live ranges from the current data: whatever Forecast returns with both bounds.
  const liveHtml = pageList(live, periods).list;
  const liveAdvice = F.recommend(live.plan, live.meta.asOf, {
    fundingSources: live.plan.funding && live.plan.funding.options, debts: live.debts,
    extraFacilities: live.revolvingExtra, periods,
  });
  const liveRanges = liveAdvice.majorPlans.filter(p => p.need == null && p.amountMin != null && p.amountMax != null);
  ok(liveRanges.length === 0, 'live plan has no range commitments after the 2026-09-23 retirements');
  ok(liveRanges.every(p => {
    const r = row(liveHtml, p.id);
    return r && r.includes(`${money2(p.amountMin)}–${money2(p.amountMax)}`)
      && !r.includes(money2((p.amountMin + p.amountMax) / 2));
  }), `live: ${liveRanges.length} range rows print min–max and never a midpoint`);
  const timingSpan = rowHtml => {
    const m = /<span data-planning-when>([^<]*)<\/span>/.exec(rowHtml || '');
    return m ? m[1] : null;
  };
  const liveDated = liveAdvice.majorPlans.filter(p => p.date);
  ok(liveDated.length > 0 && liveDated.every(p => {
    const r = row(liveHtml, p.id);
    return r && /data-planning-timing="dated"/.test(r) && timingSpan(r) === longDate(p.date);
  }), `live: ${liveDated.length} Forecast-dated rows print fmtDateFull(date)`);
  ok(liveAdvice.majorPlans.filter(p => !p.date && p.when).every(p => timingSpan(row(liveHtml, p.id)) === p.when),
    'live: every when-only approximate `when` is printed verbatim');
}

console.log('\n=== 5b. Forecast date wins over approximate when; no invented dates ===');
{
  const timingSpan = html => {
    const m = /<span data-planning-when>([^<]*)<\/span>/.exec(html || '');
    return m ? m[1] : null;
  };
  const adviceRow = extra => ({
    id: extra.id,
    label: extra.label,
    date: extra.date,
    when: extra.when,
    need: 1,
    remaining: 1,
    verdict: 'ON TRACK',
    flexibility: 'required',
    confidence: 'estimated',
  });
  const datedWithWhen = page.compose({
    majorPlans: [adviceRow({
      id: 'dated-with-when',
      label: 'Dated with month wording',
      date: '2026-12-09',
      when: 'Dec 2026',
    })],
    paydayAllocation: {},
    knowledge: {},
  }, null).list;
  const datedRow = row(datedWithWhen, 'dated-with-when');
  ok(/data-planning-timing="dated"/.test(datedRow)
      && timingSpan(datedRow) === longDate('2026-12-09')
      && timingSpan(datedRow) !== 'Dec 2026',
    'date 2026-12-09 wins over when Dec 2026 and prints the calendar date');
  ok(!/Dec 2026/.test(datedRow), 'approximate when is not printed beside a Forecast date');

  const christmas = page.compose({
    majorPlans: [adviceRow({
      id: 'dated-christmas',
      label: 'Dated holiday wording',
      date: '2026-12-25',
      when: 'by Christmas 2026',
    })],
    paydayAllocation: {},
    knowledge: {},
  }, null).list;
  const christmasRow = row(christmas, 'dated-christmas');
  ok(/data-planning-timing="dated"/.test(christmasRow)
      && timingSpan(christmasRow) === longDate('2026-12-25')
      && !/by Christmas 2026/.test(christmasRow),
    'date 2026-12-25 wins over when by Christmas 2026');

  const whenOnly = page.compose({
    majorPlans: [adviceRow({
      id: 'when-only',
      label: 'Approximate only',
      date: null,
      when: 'Dec 2026',
    })],
    paydayAllocation: {},
    knowledge: {},
  }, null).list;
  const whenRow = row(whenOnly, 'when-only');
  ok(/data-planning-timing="approximate"/.test(whenRow) && timingSpan(whenRow) === 'Dec 2026',
    'when-only rows still print approximate when');
  ok(!whenRow.includes(longDate('2026-12-09'))
      && !whenRow.includes(longDate('2026-12-15'))
      && !whenRow.includes(longDate('2026-12-25'))
      && !/December/.test(whenRow),
    'no calendar day is invented from Dec 2026');
}

console.log('\n=== 9–10. Forecast remaining / projected values unchanged; set-aside only from Forecast allocation ===');
{
  const fx = fixture();
  const html = pageList(fx, null).list;
  const advice = adviceFrom(fx, null);
  for (const p of advice.majorPlans) {
    ok(p.remaining == null ? /Unknown|Unavailable/i.test(strip(factOf(row(html, p.id), 'remaining')))
      : strip(factOf(row(html, p.id), 'remaining')).startsWith(money2(p.remaining)),
      `${p.id} prints Forecast remaining ${money2(p.remaining)} unchanged`);
  }
  const alloc = advice.paydayAllocation;
  const datedAlloc = (alloc.futureCosts || []).find(r => r.id === 'dated-point');
  ok(datedAlloc && (datedAlloc.projectedByDeadline == null
    ? /Unknown|Unavailable/i.test(strip(factOf(row(html, 'dated-point'), 'projected')))
    : strip(factOf(row(html, 'dated-point'), 'projected')).includes(money2(datedAlloc.projectedByDeadline))),
    'the dated cost prints Forecast projectedByDeadline from paydayAllocation');
  const setAside = factOf(row(html, 'dated-point'), 'set-aside');
  ok(datedAlloc && (Number(datedAlloc.allocated) > 0
    ? strip(setAside).includes(money2(datedAlloc.allocated)) && /Set aside this payday/.test(setAside)
    : /None/.test(setAside) && /No set-aside this payday/.test(setAside)),
  `set-aside mirrors Forecast allocated (${datedAlloc && datedAlloc.allocated}) — printed only as Forecast assigned it`);
  ok(/Not assigned/.test(factOf(row(html, 'point'), 'set-aside')) && /Exact date not set/.test(factOf(row(html, 'point'), 'set-aside')),
    'an undated required cost prints Not assigned (Forecast unresolved), not a $0 set-aside');
  ok(!factOf(row(html, 'point'), 'projected'), 'no projected-by-deadline is printed where Forecast produced none');
  // A composed advice with a FUNDING GAP and AT RISK row: the page prints those verdicts and remaining verbatim.
  const composed = page.compose({
    majorPlans: [
      { id: 'gap', label: 'Gap cost', date: '2026-04-01', need: 5000, flexibility: 'required', confidence: 'estimated', verdict: 'FUNDING GAP', remaining: 1234.56, deferred: false },
      { id: 'risk', label: 'Risky range', when: 'Fall 2026', amountMin: 100, amountMax: 900, flexibility: 'bounded-flex', confidence: 'estimated', adjustable: true, verdict: 'AT RISK', remaining: 800, deferred: true },
    ],
    paydayAllocation: { futureCosts: [{ id: 'gap', allocated: 250, projectedByDeadline: 3765.44 }], optional: [], unresolved: [{ id: 'risk' }] },
    knowledge: { end: '2027-03-09', encumbered: 100 },
  }, null);
  ok(/data-planning-verdict="FUNDING GAP"/.test(row(composed.list, 'gap')) && strip(factOf(row(composed.list, 'gap'), 'remaining')).includes('$1,234.56 Funding gap'),
    'FUNDING GAP verdict and remaining are printed as given');
  ok(strip(factOf(row(composed.list, 'gap'), 'set-aside')).includes('$250.00 Set aside this payday')
      && strip(factOf(row(composed.list, 'gap'), 'projected')).includes('$3,765.44 Projected available by deadline'),
    'set-aside and projection are printed as given');
  ok(/data-planning-verdict="AT RISK"/.test(row(composed.list, 'risk')) && strip(factOf(row(composed.list, 'risk'), 'remaining')).includes('$800.00 At-risk amount')
      && /MAY MOVE/.test(row(composed.list, 'risk')) && /\$100\.00–\$900\.00/.test(row(composed.list, 'risk')),
    'AT RISK verdict, remaining, MAY MOVE and range are printed as given');
  const withheld = page.compose({ operatingPlanUnavailable: true, operatingPlanNote: 'Current plan unavailable — test.' }, { operatingPlan: 'unavailable' });
  ok(/data-operating-plan="unavailable"/.test(withheld.list) && !/data-planning-id/.test(withheld.list),
    'when Forecast withholds the current operating plan, no verdict is printed (incumbent Plan rule)');
}

console.log('\n=== 11–12. No saved balance is invented; no independent ranking or total ===');
{
  const composed = pageList(live, periods);
  const html = composed.list + composed.lede + composed.note;
  ok(!/Saved \$|saved so far|\bSaved\b.*\$0/i.test(html), 'no "Saved $0" or saved-so-far figure anywhere');
  ok(/does not track a dedicated saved balance/.test(composed.note), 'the page says Atlas does not track a saved balance');
  const src = stripComments(read('public/planning.js'));
  ok(!/savedSoFar|\.sort\(|reverse\(\)|priority/.test(src), 'planning.js does not sort, reverse, or read priority; Forecast order is rendered');
  const liveAdvice = F.recommend(live.plan, live.meta.asOf, {
    fundingSources: live.plan.funding && live.plan.funding.options, debts: live.debts,
    extraFacilities: live.revolvingExtra, periods,
  });
  const pointTotal = liveAdvice.majorPlans.filter(p => p.need != null).reduce((s, p) => s + p.need, 0);
  ok(!html.includes(money2(pointTotal)), `the page does not print an independent total of point estimates (${money2(pointTotal)})`);
  const floorTotal = liveAdvice.majorPlans.reduce((s, p) => s + (p.need != null ? p.need : (p.amountMin || 0)), 0);
  ok(!html.includes(money2(floorTotal)) || Math.abs(floorTotal - liveAdvice.knowledge.encumbered) < 0.005,
    'no page-summed floor total appears unless it is Forecast\'s own protected floor');
  ok(composed.lede.includes(money2(liveAdvice.knowledge.encumbered))
      && /protected floor, not a total/.test(composed.lede)
      && /ranges count at their low end/.test(composed.lede),
    'the only aggregate is Forecast knowledge.encumbered, labelled as a protected floor with ranges at their low end');
  ok(composed.lede.includes(longDate(liveAdvice.knowledge.end)), 'the lede names the Forecast knowledge horizon end');
}

console.log('\n=== 13–15. Baseline trajectory reprints Forecast.baselineTrajectory ===');
{
  const src = stripComments(read('public/planning.js'));
  ok(/Forecast\.baselineTrajectory\(/.test(src),
    'planning.js calls Forecast.baselineTrajectory');
  ok(!/Forecast\.simulate\(|Forecast\.projectDebts\(|Forecast\.expandEvents\(/.test(src),
    'planning.js does not walk cash or debt for the trajectory table');
  const trajHtml = page.composeTrajectory(live, periods);
  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  ok(traj.status === 'ready' && Array.isArray(traj.months) && traj.months.length > 0,
    'live baselineTrajectory is ready with months');
  const tableHtml = trajHtml.table;
  ok(/planning-trajectory-table/.test(tableHtml), 'trajectory renders a table');
  for (const month of traj.months) {
    ok(new RegExp(`data-trajectory-month="${month.month}"`).test(tableHtml),
      `live: month ${month.month} is printed, not omitted`);
    const income = month.income || {};
    ok(new RegExp(`data-trajectory-month="${month.month}"[^>]*data-trajectory-income-status="${income.status}"`).test(tableHtml),
      `live: ${month.month} income status is ${income.status}`);
    if (income.status === 'unavailable') {
      ok(/Forecast unavailable/.test(tableHtml) && income.reason && tableHtml.includes(income.reason),
        `live: ${month.month} unavailable income prints Forecast reason`);
      ok(!new RegExp(`data-trajectory-month="${month.month}"[\\s\\S]*?planning-trajectory-income[^>]*>\\s*<b>\\$0\\.00</b>`).test(tableHtml),
        `live: ${month.month} unavailable income is not printed as $0`);
    } else if (income.amount != null) {
      ok(tableHtml.includes(money2(income.amount)), `live: ${month.month} income amount matches Forecast`);
    }
    const cash = month.cash || {};
    ok(new RegExp(`data-trajectory-month="${month.month}"[^>]*data-trajectory-cash-status="${cash.status}"`).test(tableHtml),
      `live: ${month.month} cash status is ${cash.status}`);
    if (cash.status === 'unavailable') {
      ok(cash.reason && tableHtml.includes(cash.reason),
        `live: ${month.month} unavailable cash prints Forecast reason`);
    } else if (cash.amount != null) {
      ok(tableHtml.includes(money2(cash.amount)), `live: ${month.month} cash amount matches Forecast`);
    }
  }
  const jan2027 = traj.months.find(m => m.month === '2027-01');
  ok(jan2027 && jan2027.income && jan2027.income.status === 'estimated'
    && jan2027.cash && jan2027.cash.status === 'estimated'
    && typeof jan2027.income.amount === 'number' && jan2027.income.amount !== 0,
    'live: January 2027 is Forecast-estimated Dale income and cash, not carried 2026 net');
  ok(/does not walk cash or debt itself/.test(trajHtml.note),
    'trajectory footnote says the page does not walk cash or debt');
  ok(!/Cash \(month-end\)/.test(tableHtml),
    'cash column is not labelled month-end (period end matches Forecast span)');
  ok(/Cash \(period end\)/.test(tableHtml), 'cash column names period end');
  ok(/Secured incl\. HELOC/.test(tableHtml) && /of which HELOC/.test(tableHtml),
    'secured vs HELOC relationship is explicit on the page');
  for (const month of traj.months) {
    ok(new RegExp(`data-trajectory-period-start="${month.start}"`).test(tableHtml)
      && new RegExp(`data-trajectory-period-end="${month.end}"`).test(tableHtml),
      `live: ${month.month} prints Forecast period ${month.start}–${month.end}`);
    const rowRe = new RegExp(
      `<tr[^>]*data-trajectory-month="${month.month}"[^>]*>[\\s\\S]*?</tr>`);
    const rowMatch = rowRe.exec(tableHtml);
    ok(rowMatch, `live: ${month.month} row is present for period inspection`);
    if (month.start.slice(0, 7) === month.month) {
      const [y, m] = month.month.split('-').map(Number);
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
      const monthEnd = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      const partial = month.start !== monthStart || month.end !== monthEnd;
      if (partial) {
        ok(/data-trajectory-partial="true"/.test(rowMatch[0]) && /Partial period/.test(rowMatch[0]),
          `live: ${month.month} partial boundary row is marked`);
      }
    }
    const cash = month.cash || {};
    if (cash.asOf) {
      ok(new RegExp(`data-trajectory-cash-asof="${cash.asOf}"`).test(tableHtml),
        `live: ${month.month} cash.asOf ${cash.asOf} is visible`);
    }
    const debt = month.debt || {};
    if (debt.asOf) {
      ok(new RegExp(`data-trajectory-debt-asof="${debt.asOf}"`).test(tableHtml),
        `live: ${month.month} debt.asOf ${debt.asOf} is visible`);
    }
  }
}

console.log('\n=== 16. Trajectory pressure reprints Forecast.baselineTrajectory.pressure ===');
{
  const src = stripComments(read('public/planning.js'));
  ok(/Forecast\.baselineTrajectory\(/.test(src),
    'pressure reprint still uses the incumbent Forecast.baselineTrajectory call');
  ok(!/baselineTrajectoryPressure|trajectorySignalAttribution|trajectoryPressureUnavailable/.test(src),
    'planning.js does not compute pressure or attribution');
  ok(/Forecast\.baselineTrajectoryScenario\(/.test(src),
    'pressure section coexists with Forecast.baselineTrajectoryScenario wiring');
  ok(/planningTrajectoryAttributionHtml\(/.test(src)
    && /signal\.attribution/.test(src),
    'planning.js reprints signal.attribution from Forecast only');
  ok(!/TRAJECTORY_DRIVER_CLASS_ORDER|trajectoryCollectCashDrivers|trajectoryCashWindowAttribution/.test(src),
    'planning.js does not import Forecast attribution math');
  ok(!/TOTAL RISK|safe-to-spend|RYG|affordability/i.test(src),
    'planning pressure attribution carries no ranking or policy-threshold wording');
  ok(!/assistant-packet|\/talk\//.test(src),
    'planning.js does not touch packet or Talk seams');

  const pressure = page.composePressure(live, periods);
  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  ok(traj.pressure && traj.pressure.status === 'ready'
    && Array.isArray(traj.pressure.signals),
    'live baselineTrajectory pressure is ready with signals');
  const pressureHtml = pressure.list;
  ok(/data-trajectory-pressure="ready"/.test(pressureHtml),
    'live pressure list is marked ready');
  ok(traj.pressure.signals.length > 0,
    'live fixture has at least one pressure signal to copy');
  const kindOrder = [...pressureHtml.matchAll(/data-trajectory-pressure-kind="([^"]+)"/g)].map(m => m[1]);
  ok(kindOrder.length === traj.pressure.signals.length,
    'live: every Forecast pressure signal is printed');
  ok(kindOrder.every((kind, i) => kind === traj.pressure.signals[i].kind),
    'live: pressure signal order matches Forecast');
  for (let i = 0; i < traj.pressure.signals.length; i++) {
    const s = traj.pressure.signals[i];
    const itemRe = new RegExp(
      `<li class="planning-trajectory-pressure-item"[^>]*data-trajectory-pressure-index="${i}"[^>]*>`);
    ok(itemRe.test(pressureHtml), `live: pressure signal ${i} (${s.kind}) is present`);
    if (s.month) {
      ok(new RegExp(`data-trajectory-pressure-index="${i}"[^>]*data-trajectory-pressure-month="${s.month}"`).test(pressureHtml),
        `live: signal ${i} month ${s.month} is copied`);
    }
    if (s.date) {
      ok(new RegExp(`data-trajectory-pressure-index="${i}"[^>]*data-trajectory-pressure-date="${s.date}"`).test(pressureHtml),
        `live: signal ${i} date ${s.date} is copied`);
    }
    if (s.trust) {
      ok(new RegExp(`data-trajectory-pressure-index="${i}"[^>]*data-trajectory-pressure-trust="${s.trust}"`).test(pressureHtml),
        `live: signal ${i} trust ${s.trust} is copied`);
      ok(new RegExp(`data-trajectory-pressure-index="${i}"[\\s\\S]*?${s.trust.toUpperCase()}`).test(pressureHtml),
        `live: signal ${i} trust chip is visible`);
    }
    if (s.amount != null && isFinite(Number(s.amount))) {
      ok(pressureHtml.includes(money2(s.amount)),
        `live: signal ${i} amount ${money2(s.amount)} is copied`);
    }
    if (s.id) {
      ok(new RegExp(`data-trajectory-pressure-index="${i}"[^>]*data-trajectory-pressure-id="${s.id}"`).test(pressureHtml),
        `live: signal ${i} id ${s.id} is copied`);
    }
    if (s.asOf) {
      ok(new RegExp(`data-trajectory-pressure-index="${i}"[^>]*data-trajectory-pressure-asof="${s.asOf}"`).test(pressureHtml),
        `live: signal ${i} asOf ${s.asOf} is copied`);
    }
  }
  const readyWithDrivers = traj.pressure.signals.find(s => s.attribution
    && s.attribution.status === 'ready'
    && Array.isArray(s.attribution.drivers)
    && s.attribution.drivers.length > 0);
  ok(readyWithDrivers, 'live fixture has a ready attribution with drivers');
  if (readyWithDrivers) {
    const idx = traj.pressure.signals.indexOf(readyWithDrivers);
    ok(new RegExp(`data-trajectory-pressure-index="${idx}"[\\s\\S]*?data-trajectory-pressure-attribution="ready"`).test(pressureHtml),
      'live: ready attribution block is printed under its signal');
    const driver = readyWithDrivers.attribution.drivers[0];
    ok(new RegExp(`data-trajectory-attribution-driver-class="${driver.class}"`).test(pressureHtml),
      `live: first driver class ${driver.class} is copied`);
    if (driver.amount != null && isFinite(Number(driver.amount))) {
      ok(pressureHtml.includes(money2(driver.amount)),
        `live: driver amount ${money2(driver.amount)} is copied`);
    }
    const startMarker = `data-trajectory-pressure-index="${idx}"`;
    const start = pressureHtml.indexOf(startMarker);
    const nextMarker = `data-trajectory-pressure-index="${idx + 1}"`;
    const next = pressureHtml.indexOf(nextMarker, start + 1);
    const itemHtml = start >= 0
      ? pressureHtml.slice(start, next > start ? next : pressureHtml.length)
      : '';
    const driverOrder = [...itemHtml.matchAll(/data-trajectory-attribution-driver-class="([^"]+)"/g)].map(m => m[1]);
    const forecastOrder = readyWithDrivers.attribution.drivers.map(d => d.class);
    ok(driverOrder.join(',') === forecastOrder.join(','),
      'live: driver order under one signal matches Forecast', `${driverOrder.join(',')} vs ${forecastOrder.join(',')}`);
    if (readyWithDrivers.attribution.change != null && isFinite(Number(readyWithDrivers.attribution.change))) {
      ok(pressureHtml.includes(money2(readyWithDrivers.attribution.change)),
        'live: attributed change amount is copied');
    }
  }
  const unavailableAttr = traj.pressure.signals.find(s => s.attribution
    && s.attribution.status === 'unavailable' && s.attribution.reason);
  ok(unavailableAttr, 'live fixture has unavailable attribution with a reason');
  if (unavailableAttr) {
    const idx = traj.pressure.signals.indexOf(unavailableAttr);
    ok(new RegExp(`data-trajectory-pressure-index="${idx}"[\\s\\S]*?data-trajectory-pressure-attribution="unavailable"`).test(pressureHtml),
      'live: unavailable attribution block is printed under its signal');
    ok(pressureHtml.includes(unavailableAttr.attribution.reason),
      'live: unavailable attribution prints Forecast attribution.reason');
  }

  const missingAttrHtml = page.ctx.planningTrajectoryPressureSignalHtml({
    kind: 'cash-trough', date: '2026-01-01', amount: 100,
  }, 0);
  ok(/data-trajectory-pressure-attribution="unavailable"/.test(missingAttrHtml),
    'missing attribution object is unavailable, not invented');
  ok(!/data-trajectory-attribution-driver-class=/.test(missingAttrHtml),
    'missing attribution does not invent drivers');

  const missingTraj = F.baselineTrajectory(null, [], live.meta.asOf, { periods });
  const missingPressure = page.composePressure({ plan: null, debts: [], meta: { asOf: live.meta.asOf }, revolvingExtra: null }, periods);
  ok(missingTraj.pressure && missingTraj.pressure.status === 'unavailable',
    'missing plan pressure is unavailable on Forecast');
  ok(/data-trajectory-pressure="unavailable"/.test(missingPressure.list),
    'unavailable pressure is not rendered as an empty success');
  ok(missingPressure.list.includes(missingTraj.pressure.reason),
    'unavailable pressure prints Forecast pressure.reason');
  ok(/does not score, rank, or compute pressure or attribution/.test(missingPressure.note),
    'pressure footnote says the page does not compute pressure or attribution');
}

console.log('\n=== 17. Trajectory debt direction reprints Forecast.baselineTrajectory.debtDirection ===');
{
  const src = stripComments(read('public/planning.js'));
  ok(/Forecast\.baselineTrajectory\(/.test(src),
    'debt direction reprint still uses the incumbent Forecast.baselineTrajectory call');
  ok(/planningTrajectoryDebtDirectionHtml\(/.test(src) && /traj\.debtDirection/.test(src),
    'planning.js reprints traj.debtDirection from Forecast only');
  ok(!/baselineTrajectoryDebtDirection|trajectoryBalanceDirection|trajectoryDebtDirectionUnavailable/.test(src),
    'planning.js does not compute debt direction');
  ok(!/assistant-packet|\/talk\//.test(src),
    'planning.js does not touch packet or Talk seams');
  ok(!/payoff order|comfort band|affordability|safe-to-spend|RYG/i.test(src),
    'debt direction copy carries no ranking or policy-threshold wording');

  const debtDirection = page.composeDebtDirection(live, periods);
  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  ok(traj.debtDirection && traj.debtDirection.status === 'ready'
    && Array.isArray(traj.debtDirection.debts),
    'live baselineTrajectory debtDirection is ready with per-debt rows');
  const ddHtml = debtDirection.list;
  ok(/data-trajectory-debt-direction="ready"/.test(ddHtml),
    'live debt direction block is marked ready');
  const h = traj.debtDirection.household || {};
  if (h.direction) {
    ok(new RegExp(`data-trajectory-debt-direction-household-direction="${h.direction}"`).test(ddHtml),
      'live household direction is copied');
    if (h.opening != null && isFinite(Number(h.opening))) {
      ok(ddHtml.includes(money2(h.opening)), 'live household opening is copied');
    }
    if (h.ending != null && isFinite(Number(h.ending))) {
      ok(ddHtml.includes(money2(h.ending)), 'live household ending is copied');
    }
  }
  if (traj.debtDirection.inventedBorrowing === false) {
    ok(/Invented borrowing/.test(ddHtml) && /no \(Forecast\)/.test(ddHtml),
      'live inventedBorrowing false is copied');
  }
  if (traj.debtDirection.availableCreditIsNotCash === true) {
    ok(/Available credit is not cash/.test(ddHtml),
      'live availableCreditIsNotCash is stated');
  }
  for (const kind of ['declining', 'persistent', 'increasing']) {
    const ids = Array.isArray(traj.debtDirection[kind]) ? traj.debtDirection[kind] : [];
    if (!ids.length) {
      ok(new RegExp(`data-trajectory-debt-direction-${kind}="none"`).test(ddHtml),
        `live: no ${kind} debts marker is present`);
    } else {
      ok(new RegExp(`data-trajectory-debt-direction-${kind}="ready"`).test(ddHtml),
        `live: ${kind} id list is present`);
      for (const id of ids) {
        ok(new RegExp(`data-trajectory-debt-direction-debt-id="${id}"`).test(ddHtml),
          `live: ${kind} list includes ${id}`);
      }
    }
  }
  ok(traj.debtDirection.debts.length > 0, 'live fixture has per-debt direction rows');
  for (let i = 0; i < traj.debtDirection.debts.length; i++) {
    const debt = traj.debtDirection.debts[i];
    const itemRe = new RegExp(
      `<li class="planning-trajectory-debt-direction-item"[^>]*data-trajectory-debt-direction-index="${i}"[^>]*>`);
    ok(itemRe.test(ddHtml), `live: debt direction row ${i} (${debt.id}) is present`);
    if (debt.direction) {
      ok(new RegExp(`data-trajectory-debt-direction-index="${i}"[^>]*data-trajectory-debt-direction-direction="${debt.direction}"`).test(ddHtml),
        `live: debt ${debt.id} direction ${debt.direction} is copied`);
    }
    if (debt.opening != null && isFinite(Number(debt.opening))) {
      ok(ddHtml.includes(money2(debt.opening)), `live: debt ${debt.id} opening is copied`);
    }
    if (debt.ending != null && isFinite(Number(debt.ending))) {
      ok(ddHtml.includes(money2(debt.ending)), `live: debt ${debt.id} ending is copied`);
    }
    if (debt.interest && debt.interest.status === 'calculated'
      && debt.interest.amount != null && isFinite(Number(debt.interest.amount))) {
      ok(ddHtml.includes(money2(debt.interest.amount)),
        `live: debt ${debt.id} interest amount is copied`);
    } else if (debt.interest && debt.interest.status === 'unavailable' && debt.interest.reason) {
      ok(ddHtml.includes(debt.interest.reason),
        `live: debt ${debt.id} unavailable interest prints reason, not $0`);
    }
    if (debt.milestone && debt.milestone.kind === 'cleared-within-published-horizon') {
      ok(new RegExp(`data-trajectory-debt-direction-milestone="${debt.milestone.kind}"`).test(ddHtml),
        `live: debt ${debt.id} cleared-within-published-horizon milestone is copied`);
      if (debt.milestone.month) {
        ok(new RegExp(`data-trajectory-debt-direction-milestone-month="${debt.milestone.month}"`).test(ddHtml),
          `live: debt ${debt.id} milestone month is copied`);
      }
    }
  }
  const debtOrder = [...ddHtml.matchAll(/data-trajectory-debt-direction-index="(\d+)"[^>]*data-trajectory-debt-direction-debt-id="([^"]+)"/g)]
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map(m => m[2]);
  ok(debtOrder.join(',') === traj.debtDirection.debts.map(d => d.id).join(','),
    'live: per-debt order matches Forecast');

  const missingTraj = F.baselineTrajectory(null, [], live.meta.asOf, { periods });
  const missingDd = page.composeDebtDirection({ plan: null, debts: [], meta: { asOf: live.meta.asOf }, revolvingExtra: null }, periods);
  ok(missingTraj.debtDirection && missingTraj.debtDirection.status === 'unavailable',
    'missing plan debtDirection is unavailable on Forecast');
  ok(/data-trajectory-debt-direction="unavailable"/.test(missingDd.list),
    'unavailable debt direction is not rendered as an empty success');
  ok(missingDd.list.includes(missingTraj.debtDirection.reason),
    'unavailable debt direction prints Forecast debtDirection.reason');
  ok(/does not rank debts, recommend which debt to pay first, or compute direction/.test(missingDd.note),
    'debt direction footnote says the page does not compute direction');
}

console.log('\n=== 18. Trajectory three-stage funding reprints Forecast.baselineTrajectory stage1/2/3 ===');
{
  const src = stripComments(read('public/planning.js'));
  ok(/Forecast\.baselineTrajectory\(/.test(src),
    'funding reprint still uses the incumbent Forecast.baselineTrajectory call');
  ok(/planningTrajectoryFundingHtml\(/.test(src) && /period\.stage1/.test(src)
    && /period\.stage2/.test(src) && /period\.stage3/.test(src)
    && /traj\.months/.test(src),
    'planning.js reprints Forecast stage1 / stage2 / stage3 from months[] or payPeriods[] only');
  ok(!/baselineTrajectoryMonthFunding/.test(src),
    'planning.js does not call the internal funding helper');
  ok(!/stage1Amount|stage2Amount|stage3Amount/.test(src),
    'planning.js does not recompute stage amounts');
  ok(!/assistant-packet|\/talk\//.test(src),
    'planning.js does not touch packet or Talk seams');
  ok(!/safe-to-spend|affordability|sustainable|breathing room/i.test(src),
    'funding copy carries no policy-threshold or comfort wording');

  const funding = page.composeFunding(live, periods);
  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  ok(traj.status === 'ready' && traj.months.length > 0, 'live trajectory has months with funding stages');
  const pickMonth = traj.months[0];
  const fundingHtml = funding.panel;
  ok(/data-trajectory-funding-month="/.test(fundingHtml),
    'live funding panel renders for a selected month');
  ok(/data-trajectory-funding-stage="1"/.test(fundingHtml)
    && /data-trajectory-funding-stage="2"/.test(fundingHtml)
    && /data-trajectory-funding-stage="3"/.test(fundingHtml),
    'live funding panel shows all three stages');
  ok(/Normal life/.test(fundingHtml) && /After planned spending/.test(fundingHtml)
    && /After debt strategy/.test(fundingHtml),
    'live funding uses Forecast stage labels');
  if (pickMonth.stage1 && pickMonth.stage1.result) {
    ok(fundingHtml.includes(money2(pickMonth.stage1.result.amount)),
      'live stage 1 result amount is copied from Forecast');
    if (pickMonth.stage1.result.status === 'estimated') {
      ok(/ESTIMATED/.test(fundingHtml), 'live estimated stage 1 stays estimated on the page');
    }
  }
  if (pickMonth.stage2 && pickMonth.stage2.result && isFinite(pickMonth.stage2.result.amount)) {
    ok(fundingHtml.includes(money2(pickMonth.stage2.result.amount)),
      'live stage 2 result amount is copied from Forecast');
  }
  if (pickMonth.stage3 && pickMonth.stage3.result && isFinite(pickMonth.stage3.result.amount)) {
    ok(fundingHtml.includes(money2(pickMonth.stage3.result.amount)),
      'live stage 3 result amount is copied from Forecast');
  }
  const unavailableMonth = traj.months.find(m => m.stage1 && m.stage1.status === 'unavailable');
  if (unavailableMonth) {
    const withheld = page.composeFunding(live, periods, 'month', unavailableMonth.month);
    ok(/data-trajectory-funding-stage-status="unavailable"/.test(withheld.panel),
      'unavailable month stage prints unavailable status');
    ok(unavailableMonth.stage1.reason && withheld.panel.includes(unavailableMonth.stage1.reason),
      'unavailable stage prints Forecast reason');
    ok(!new RegExp(`data-trajectory-funding-month="${unavailableMonth.month}"[\\s\\S]*?data-trajectory-funding-result="ready"[\\s\\S]*?<b>\\$0\\.00</b>`).test(withheld.panel),
      'unavailable funding is not printed as $0 surplus');
  }

  const composed = page.composeFunding({
    plan: null, debts: [], meta: { asOf: live.meta.asOf }, revolvingExtra: null,
  }, periods, 'month', null);
  ok(/data-trajectory-funding="unavailable"/.test(composed.panel),
    'missing trajectory funding is not rendered as an empty success');
  ok(/does not subtract stages, recompute funding/.test(composed.note),
    'funding footnote says the page does not recompute stages');

  const pressureStill = page.composePressure(live, periods).list;
  const ddStill = page.composeDebtDirection(live, periods).list;
  ok(/data-trajectory-pressure="ready"/.test(pressureStill) || /data-trajectory-pressure="empty"/.test(pressureStill),
    'pressure composer remains after funding compose');
  ok(/data-trajectory-debt-direction="ready"/.test(ddStill) || /data-trajectory-debt-direction="unavailable"/.test(ddStill),
    'debt direction composer remains after funding compose');
}

console.log('\n=== 19. Trajectory month selection keeps table row semantics ===');
{
  const src = stripComments(read('public/planning.js'));
  ok(!/<tr[^>]*\brole="button"/.test(src),
    'planning.js does not assign role=button to trajectory rows');
  ok(!/<tr[^>]*aria-label="Show three-stage funding/.test(src),
    'planning.js does not replace the row accessible name with a funding-action label');
  ok(/<button type="button"[^>]*data-trajectory-month-select=/.test(src),
    'month selection is a real button inside the row');

  const tableHtml = page.composeTrajectory(live, periods).table;
  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  ok(traj.status === 'ready' && traj.months.length > 0, 'live trajectory has months for row-semantics proof');
  ok(/<table[^>]*class="[^"]*planning-trajectory-table/.test(tableHtml)
    && /<th scope="col">Period<\/th>/.test(tableHtml)
    && /<th scope="col">Income<\/th>/.test(tableHtml)
    && /<th scope="col">Cash \(period end\)<\/th>/.test(tableHtml)
    && /<th scope="col">Debt<\/th>/.test(tableHtml),
    'trajectory table keeps column headers for period, income, cash, and debt');
  ok(!/<tr[^>]*\brole="button"/.test(tableHtml),
    'rendered trajectory rows keep implicit row role');
  ok(!/<tr[^>]*aria-label=/.test(tableHtml),
    'rendered trajectory rows have no aria-label that would hide cell figures');
  ok(!/Show three-stage funding/.test(tableHtml),
    'funding-action wording is not the row or button accessible name');

  for (const month of traj.months) {
    const rowRe = new RegExp(
      `<tr[^>]*data-trajectory-month="${month.month}"[^>]*>([\\s\\S]*?)</tr>`);
    const rowMatch = rowRe.exec(tableHtml);
    ok(rowMatch && !/\brole="button"/.test(rowMatch[0].slice(0, rowMatch[0].indexOf('>'))),
      `live: ${month.month} remains a table row without an override role`);
    if (!rowMatch) continue;
    const rowHtml = rowMatch[1];
    ok(/<th scope="row">/.test(rowHtml),
      `live: ${month.month} keeps a row header`);
    ok(/<td class="planning-trajectory-income">/.test(rowHtml)
      && /<td class="planning-trajectory-cash">/.test(rowHtml)
      && /<td class="planning-trajectory-debt">/.test(rowHtml),
      `live: ${month.month} income, cash, and debt stay table cells`);
    const buttonRe = new RegExp(
      `<button type="button"[^>]*data-trajectory-month-select="${month.month}"[^>]*>[\\s\\S]*?<span class="planning-trajectory-period">${month.month}</span>[\\s\\S]*?</button>`);
    ok(buttonRe.test(rowHtml),
      `live: ${month.month} selection is a button named after the month, inside the row`);
    const income = month.income || {};
    if (income.status !== 'unavailable' && income.amount != null) {
      ok(rowHtml.includes(money2(income.amount)),
        `live: ${month.month} Forecast income amount remains in the row cells`);
    }
    const cash = month.cash || {};
    if (cash.status !== 'unavailable' && cash.amount != null) {
      ok(rowHtml.includes(money2(cash.amount)),
        `live: ${month.month} Forecast cash amount remains in the row cells`);
    }
  }
}

console.log('\n=== 20. Trajectory Month ↔ Pay Period funding granularity ===');
{
  const src = stripComments(read('public/planning.js'));
  ok(/traj\.payPeriods/.test(src) && /payPeriods\.map/.test(src),
    'planning.js consumes Forecast payPeriods[] for Pay period view');
  ok(/traj\.months/.test(src) && /period\.stage1/.test(src),
    'planning.js still consumes Forecast months[] for Month view');
  ok(/data-trajectory-funding-granularity=/.test(src),
    'planning.js exposes Month / Pay period granularity control');
  ok(!/baselineTrajectoryMonthFunding/.test(src)
    && !/stage1Amount|stage2Amount|stage3Amount/.test(src),
    'planning.js does not recompute stage amounts in either granularity');
  ok(!/public\/forecast\.js/.test(src) && !/assistant-packet|\/talk\//.test(src),
    'planning.js does not edit forecast, packet, or Talk seams');

  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  ok(traj.status === 'ready' && traj.months.length > 0, 'live trajectory has months');
  ok(Array.isArray(traj.payPeriods) && traj.payPeriods.length > 0,
    'live trajectory has payPeriods for granularity proof');

  const monthFunding = page.composeFunding(live, periods, 'month', traj.months[0].month);
  const pickMonth = traj.months[0];
  ok(/data-trajectory-funding-granularity="month"/.test(monthFunding.panel),
    'Month view panel names month granularity');
  ok(monthFunding.panel.includes(money2(pickMonth.stage1.result.amount)),
    'Month view copies Forecast months[] stage1 result without Planning arithmetic');
  if (pickMonth.stage2 && pickMonth.stage2.result && isFinite(pickMonth.stage2.result.amount)) {
    ok(monthFunding.panel.includes(money2(pickMonth.stage2.result.amount)),
      'Month view copies stage2 result from Forecast');
  }
  if (pickMonth.stage3 && pickMonth.stage3.result && isFinite(pickMonth.stage3.result.amount)) {
    ok(monthFunding.panel.includes(money2(pickMonth.stage3.result.amount)),
      'Month view copies stage3 result from Forecast');
  }

  const pickPeriod = traj.payPeriods[0];
  const periodId = pickPeriod.payday || pickPeriod.id;
  const periodFunding = page.composeFunding(live, periods, 'pay-period', periodId);
  ok(/data-trajectory-funding-granularity="pay-period"/.test(periodFunding.panel),
    'Pay period view panel names pay-period granularity');
  ok(/data-trajectory-funding-pay-period="/.test(periodFunding.panel),
    'Pay period view keys the selected pay period from Forecast');
  ok(periodFunding.panel.includes(money2(pickPeriod.stage1.result.amount)),
    'Pay period view copies Forecast payPeriods[] stage1 result');
  if (pickPeriod.stage2 && pickPeriod.stage2.result && isFinite(pickPeriod.stage2.result.amount)) {
    ok(periodFunding.panel.includes(money2(pickPeriod.stage2.result.amount)),
      'Pay period view copies stage2 from Forecast payPeriods[]');
  }
  if (pickPeriod.stage3 && pickPeriod.stage3.result && isFinite(pickPeriod.stage3.result.amount)) {
    ok(periodFunding.panel.includes(money2(pickPeriod.stage3.result.amount)),
      'Pay period view copies stage3 from Forecast payPeriods[]');
  }

  const pickerHtml = page.composeFunding(live, periods, 'month', traj.months[0].month).picker;
  ok(/data-trajectory-funding-granularity="month"/.test(pickerHtml)
    && /data-trajectory-funding-granularity="pay-period"/.test(pickerHtml),
    'funding composer still exposes Month and Pay period controls');

  const estimatedPeriod = traj.payPeriods.find(p => p.stage1 && p.stage1.status === 'estimated');
  if (estimatedPeriod) {
    const estHtml = page.composeFunding(live, periods, 'pay-period',
      estimatedPeriod.payday || estimatedPeriod.id).panel;
    ok(/ESTIMATED/.test(estHtml), 'estimated pay-period stage stays estimated on the page');
  }
  const unavailableStageMonth = traj.months.find(m => m.stage1 && m.stage1.status === 'unavailable');
  if (unavailableStageMonth) {
    const withheld = page.composeFunding(live, periods, 'month', unavailableStageMonth.month).panel;
    ok(unavailableStageMonth.stage1.reason && withheld.includes(unavailableStageMonth.stage1.reason),
      'unavailable month stage still prints Forecast reason in Month view');
    ok(!new RegExp(`<b>\\$0\\.00</b>[\\s\\S]*?data-trajectory-funding-stage="1"`).test(withheld),
      'unavailable month funding is not implied $0 surplus');
  }

  const altPlan = JSON.parse(JSON.stringify(live.plan));
  if (altPlan.defaults) altPlan.defaults.extraDebtMonthly = (altPlan.defaults.extraDebtMonthly || 0) + 50;
  const altTraj = F.baselineTrajectory(altPlan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  const altPeriod = altTraj.payPeriods[0];
  const basePeriod = traj.payPeriods[0];
  const altPanel = page.composeFunding(
    { plan: altPlan, debts: live.debts, meta: live.meta, revolvingExtra: live.revolvingExtra },
    periods, 'pay-period', altPeriod.payday || altPeriod.id).panel;
  const basePanel = page.composeFunding(live, periods, 'pay-period', basePeriod.payday || basePeriod.id).panel;
  if (altPeriod.stage3 && basePeriod.stage3
    && isFinite(altPeriod.stage3.result.amount) && isFinite(basePeriod.stage3.result.amount)
    && altPeriod.stage3.result.amount !== basePeriod.stage3.result.amount) {
    ok(altPanel.includes(money2(altPeriod.stage3.result.amount))
      && !altPanel.includes(money2(basePeriod.stage3.result.amount)),
      'changing Forecast fixture changes rendered pay-period stage3 without Planning arithmetic');
  }

  const pressureStill = page.composePressure(live, periods).list;
  const ddStill = page.composeDebtDirection(live, periods).list;
  const tableStill = page.composeTrajectory(live, periods).table;
  ok(/planning-trajectory-table/.test(tableStill),
    'monthly cash/debt composer remains after granularity work');
  ok(/data-trajectory-pressure=/.test(pressureStill),
    'pressure composer remains after granularity work');
  ok(/data-trajectory-debt-direction=/.test(ddStill),
    'debt direction composer remains after granularity work');
}

console.log('\n=== 21. Leftover three-stage funding drawer is absent from primary markup ===');
{
  const html = read('public/planning.html');
  ok(!/id="planning-trajectory-funding"/.test(html)
    && !/Three-stage funding \(expanded picker\)/.test(html),
    'planning.html has no three-stage funding drawer shell');
  const liveEl = page.render(live, periods);
  ok(!liveEl['planning-trajectory-funding']
    && !liveEl['planning-trajectory-funding-picker'],
    'renderPlanning does not fill leftover funding drawer ids');
  const monthLabel = page.ctx.planningTrajectoryFundingRegionAriaLabel('month');
  const payLabel = page.ctx.planningTrajectoryFundingRegionAriaLabel('pay-period');
  ok(/trajectory month/i.test(monthLabel) && !/pay period/i.test(monthLabel),
    'Month aria-label helper still names a trajectory month, not a pay period');
  ok(/Seaspan pay period/i.test(payLabel) && !/trajectory month/i.test(payLabel),
    'Pay period aria-label helper still names a Seaspan pay period, not a trajectory month');

  const payFunding = page.composeFunding(live, periods, 'pay-period',
    (F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
      periods, extraFacilities: live.revolvingExtra,
    }).payPeriods[0].payday));
  ok(/data-trajectory-funding-granularity="pay-period"/.test(payFunding.panel),
    'Pay period compose still targets pay-period panel');
  ok(payLabel !== monthLabel,
    'Month and Pay period accessible names do not contradict each other');
}

console.log('\n=== 22. Your Financial Road Ahead dashboard compose ===');
{
  const src = stripComments(read('public/planning.js'));
  ok(/function planningRoadAheadHtml\(/.test(src) && /planningRoadAheadLeadHtml\(/.test(src),
    'planning.js composes the road-ahead dashboard from Forecast trajectory only');
  ok(/planningRoadStageResult\(/.test(src) && /dateOrderResult/.test(src)
    && /planningRoadAheadWaterfallHtml\(/.test(src),
    'road-ahead lead and waterfall read Forecast date-order Month results');
  const roadSrc = src.split('function planningRoadAheadPeriodKey')[1].split('function planningTrajectoryFundingHtml')[0];
  ok(!/sustainable|on track|healthy|affordability|safe-to-spend|RYG|min-cash|What can you do/i.test(roadSrc),
    'road-ahead copy carries no invented judgment or recommendation engine');
  ok(!/stage1Amount|stage2Amount|stage3Amount|baselineTrajectoryMonthFunding/.test(src),
    'road-ahead does not recompute stage amounts');
  const scrollFn = src.match(/function planningRoadAheadScrollSelectedTimeline\([\s\S]*?\n\}/);
  ok(scrollFn && !/scrollIntoView/.test(scrollFn[0]),
    'road-ahead timeline scroll keeps selection visible without scrollIntoView');
  ok(scrollFn && /scrollTo|scrollLeft/.test(scrollFn[0]),
    'road-ahead timeline scroll adjusts the horizontal strip only');

  const liveEl = page.render(live, periods);
  const roadHtml = liveEl['planning-road-ahead'].innerHTML;
  ok(/Your Financial Road Ahead|planning-road-ahead|data-road-timeline="ready"/.test(roadHtml)
    || /data-road-lead=/.test(roadHtml),
    'live page renders the road-ahead dashboard region');
  ok(/data-road-timeline="ready"/.test(roadHtml), 'live timeline is marked ready');
  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  const pickMonth = traj.months[0];
  const road = page.composeRoadAhead(live, periods, 'month', pickMonth.month, live.meta.asOf);
  ok(road.lead.includes(page.ctx.planningRoadSignedMoney(pickMonth.stage1.result.amount))
    && road.lead.includes(page.ctx.planningRoadSignedMoney(pickMonth.stage2.result.amount))
    && /data-planning-road-decision-step="before"/.test(road.lead)
    && /data-planning-road-decision-step="planned"/.test(road.lead)
    && /data-planning-road-decision-step="after"/.test(road.lead),
    'hero reprints Forecast stage1, planned spending, and stage2 for the selected month');
  ok(road.selected.includes(money2(pickMonth.stage3.result.amount)),
    'selected period panel still copies Forecast stage3 in the secondary debt disclosure');
  const gapMonth = traj.months.find(m => m.stage2 && m.stage2.result
    && isFinite(m.stage2.result.amount) && m.stage2.result.amount < 0);
  if (gapMonth) {
    const gapRoad = page.composeRoadAhead(live, periods, 'month', gapMonth.month, live.meta.asOf);
    ok(/data-road-lead="period-shortfall"/.test(gapRoad.lead)
      && gapRoad.lead.includes(page.ctx.planningRoadSignedMoney(gapMonth.stage2.result.amount))
      && /Shortfall after deductions/.test(gapRoad.lead)
      && /planning-road-lead-neutral/.test(gapRoad.lead),
      'when Forecast publishes a negative stage2, selecting that month leads with that shortfall on a neutral card');
  } else {
    ok(/data-road-lead="period-surplus"|data-road-lead="period-even"|data-road-lead="period-unavailable"/.test(road.lead),
      'without a negative stage3 on live data, lead reprints the selected month Forecast result — not an invented gap');
  }
  ok(/data-road-lead="(period-surplus|period-shortfall|period-even|period-unavailable|unavailable|series-unavailable)"/.test(road.lead),
    'lead card uses a closed Forecast-backed lead kind');
  if (traj.pressure && traj.pressure.status === 'ready') {
    const forward = traj.pressure.signals.find(s => (s.date && s.date >= live.meta.asOf)
      || (s.month && s.month >= live.meta.asOf.slice(0, 7)));
    if (forward && forward.amount != null && isFinite(Number(forward.amount))
      && /data-road-lead="pressure"/.test(road.lead)) {
      ok(road.lead.includes(money2(forward.amount)),
        'pressure lead copies the first forward signal amount from Forecast');
    }
  }
  const withheld = page.composeRoadAhead({ plan: null, debts: [], meta: { asOf: live.meta.asOf }, revolvingExtra: null }, periods, 'month', null, live.meta.asOf);
  ok(/data-road-lead="unavailable"|data-road-timeline="unavailable"/.test(withheld.lead + withheld.timeline),
    'unavailable trajectory fails closed on the dashboard');
}

console.log('\n=== 23. Pay period road-ahead lead fails closed when payPeriods[] is empty ===');
{
  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  ok(traj.status === 'ready' && traj.months.length > 0 && traj.payPeriods.length > 0,
    'live walk publishes both month and pay-period series before strip');
  ok(traj.pressure && traj.pressure.status === 'ready' && traj.pressure.signals.length > 0,
    'live monthly pressure.signals publish on the same walk');
  const stripped = Object.assign({}, traj, {
    payPeriods: [],
    provenance: Object.assign({}, traj.provenance || {}, { payPeriodSeries: 'unavailable' }),
  });
  const monthLead = page.composeRoadAheadTraj(stripped, 'month', traj.months[0].month, live.meta.asOf).lead;
  ok(/data-road-lead="period-surplus"|data-road-lead="period-shortfall"|data-road-lead="period-even"|data-road-lead="period-unavailable"/.test(monthLead),
    'Month granularity still reprints a monthly Forecast result when months[] exists');
  const payLead = page.composeRoadAheadTraj(stripped, 'pay-period', null, live.meta.asOf).lead;
  ok(/data-road-lead="series-unavailable"/.test(payLead)
    && /data-road-lead-granularity="pay-period"/.test(payLead),
    'Pay period lead is series-unavailable, not monthly pressure');
  ok(!/data-road-lead="pressure"/.test(payLead),
    'Pay period lead does not fall through to global monthly pressure.signals');
  ok(/Seaspan payroll calendar missing or clipped empty/.test(payLead),
    'Pay period unavailable lead prints Forecast pay-period-series reason');
  const forward = traj.pressure.signals.find(s => (s.date && s.date >= live.meta.asOf)
    || (s.month && s.month >= live.meta.asOf.slice(0, 7)));
  if (forward && forward.amount != null && isFinite(Number(forward.amount))
    && /data-road-lead="pressure"/.test(monthLead)) {
    ok(monthLead.includes(money2(forward.amount)) && !payLead.includes(money2(forward.amount)),
      'monthly pressure amount on Month lead is absent from Pay period lead when series unavailable');
  }
}

function scenarioWireHarness(debtId, amount) {
  const debtEl = { value: debtId };
  const amountEl = { value: amount };
  const form = {
    onsubmit: null,
    querySelector(sel) {
      if (String(sel).includes('debt')) return debtEl;
      if (String(sel).includes('amount')) return amountEl;
      return null;
    },
  };
  const clearBtn = { onclick: null };
  const drawer = { ontoggle: null, open: false };
  const root = {
    querySelector(sel) {
      const s = String(sel);
      if (s.includes('data-trajectory-scenario-form')) return form;
      if (s.includes('data-trajectory-scenario-action="clear"')) return clearBtn;
      if (s.includes('data-trajectory-scenario-section')) return drawer;
      return null;
    },
  };
  return { root, form, clearBtn, drawer };
}

function roadPrimaryHtml(html) {
  return String(html || '').split('<details class="planning-road-scenario-sheet"')[0];
}

console.log('\n=== 24. Extra debt payment scenario — Forecast.baselineTrajectoryScenario on Planning ===');
{
  const src = stripComments(read('public/planning.js'));
  ok(/function planningTrajectoryScenario\(/.test(src)
    && /Forecast\.baselineTrajectoryScenario\(/.test(src),
    'planning.js calls Forecast.baselineTrajectoryScenario through one helper');
  ok(/return Forecast\.baselineTrajectoryScenario\(/.test(src)
    && (src.match(/return Forecast\.baselineTrajectoryScenario\(/g) || []).length === 1,
    'planning.js has exactly one Forecast.baselineTrajectoryScenario call site');
  ok(/function planningRoadAheadScenarioHtml\(/.test(src)
    && /planningRoadScenarioWire\(/.test(src)
    && /planningRoadAheadScenarioHtml\(d, periods\)/.test(src),
    'renderPlanning remounts the incumbent scenario disclosure and wires it');
  ok(/planningTrajectoryScenarioCompareHtml\(/.test(src)
    && /result\.delta/.test(src)
    && /result\.baseline/.test(src)
    && /result\.scenario/.test(src),
    'scenario compare copies Forecast baseline, scenario, and delta only');
  ok(!/delta\.debt\.ending\s*[-+*/]/.test(src)
    && !/delta\.cash\.ending\s*[-+*/]/.test(src),
    'planning.js does not recompute scenario deltas in the browser');
  const scenarioBlock = src.split('function planningTrajectoryScenario(')[1]
    .split('function planningPageHtml')[0];
  ok(!/paydayAllocation|additionalCashRequired|budgetBreakdown|hypotheticalExtraPayment/.test(scenarioBlock),
    'scenario helpers do not call payday, ACR, budget, or the recommend-weekly hypothetical');
  ok(!/recommend\(|safe-to-spend|affordability|RYG|min-cash|should pay|recommended/i.test(
    src.split('function planningTrajectoryScenarioCompareHtml')[1].split('function planningTrajectoryScenarioControlsHtml')[0]),
    'scenario panel copy carries no recommendation or policy-threshold wording');
  ok(!/writeFile|fetch\(|localStorage|sessionStorage/.test(src),
    'scenario UI does not persist or fetch household evidence');
  const renderSrc = src.split('function renderPlanning')[1].split('App.register')[0];
  ok(!/planningAdvice\(|paydayAllocation|additionalCashRequired/.test(renderSrc),
    'renderPlanning does not touch Prepare Ahead, payday allocation, or ACR');
  ok(/data-planning-road-secondary="scenario"/.test(src)
    && !/data-planning-road-primary="whatif"/.test(src)
    && !/planning-road-whatif-quarantine/.test(src)
    && !/What-if: extra payment/.test(src),
    'scenario mounts as secondary disclosure, not the leftover primary what-if quarantine');

  const eligible = (live.debts || []).filter(d => page.ctx.planningScenarioEligibleDebt(d));
  ok(eligible.length > 0, 'live opening has at least one scenario-eligible debt');
  const pick = eligible[0];
  const amountA = 100;
  const amountB = 250;
  const forecastA = F.baselineTrajectoryScenario(live.plan, live.debts, live.meta.asOf, {
    nature: 'additional-debt-payment',
    debtId: pick.id,
    amount: amountA,
    periods,
    extraFacilities: live.revolvingExtra,
  });
  const forecastB = F.baselineTrajectoryScenario(live.plan, live.debts, live.meta.asOf, {
    nature: 'additional-debt-payment',
    debtId: pick.id,
    amount: amountB,
    periods,
    extraFacilities: live.revolvingExtra,
  });
  const trajBaseline = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  ok(forecastA.status === 'ready' && forecastB.status === 'ready',
    'live Forecast scenario API is ready for two explicit amounts');
  if (forecastA.baseline && forecastA.baseline.cash && trajBaseline.months.length) {
    const last = trajBaseline.months[trajBaseline.months.length - 1];
    if (forecastA.baseline.cash.ending != null && last.cash && last.cash.amount != null
      && forecastA.baseline.cash.asOf === last.end) {
      ok(Math.abs(Number(forecastA.baseline.cash.ending) - Number(last.cash.amount)) < 0.005,
        'scenario baseline cash ending independently matches baselineTrajectory last published close');
    }
  }

  page.ctx.planningScenarioSetActive(null);
  page.ctx.planningScenarioDraftDebtId = '';
  page.ctx.planningScenarioDraftAmount = '';
  page.ctx.planningScenarioFormError = '';
  page.ctx.planningScenarioDrawerOpen = false;
  const idleRender = page.render(live, periods);
  const roadIdle = idleRender['planning-road-ahead'].innerHTML;
  ok(/data-planning-road-secondary="scenario"/.test(roadIdle)
    && /data-trajectory-scenario-section="controls"/.test(roadIdle)
    && /data-trajectory-scenario-form="ready"/.test(roadIdle),
    'idle Road Ahead mounts the extra-debt disclosure with explicit debt and amount controls');
  ok(/data-trajectory-scenario="idle"/.test(roadIdle)
    && !/data-trajectory-scenario="ready"/.test(roadIdle)
    && !/data-trajectory-scenario="unavailable"/.test(roadIdle),
    'idle disclosure reprints the baseline-only preview, not Forecast-unavailable');
  ok(!/What-if: extra payment/.test(roadIdle)
    && !/data-planning-road-primary="whatif"/.test(roadIdle)
    && !/planning-road-whatif-quarantine/.test(roadIdle)
    && !/This is a preview, not a change/.test(roadIdle),
    'idle mount is not the leftover primary what-if quarantine');
  const composedRoad = page.composeRoadAhead(live, periods);
  ok(!/data-trajectory-scenario-section="controls"/.test(
    composedRoad.lead + composedRoad.stages + composedRoad.breakdown + composedRoad.selected),
    'planningRoadAheadHtml stays baseline-only; scenario is not inside the trajectory composer');

  const composedA = page.composeScenario(live, periods, pick.id, amountA);
  ok(/data-trajectory-scenario="ready"/.test(composedA.panel),
    'composed scenario panel is ready when Forecast is ready');
  if (forecastA.baseline && forecastA.baseline.cash && forecastA.baseline.cash.ending != null) {
    ok(composedA.panel.includes(money2(forecastA.baseline.cash.ending)),
      'baseline projected cash matches Forecast.baselineTrajectoryScenario');
  }
  if (forecastA.scenario && forecastA.scenario.cash && forecastA.scenario.cash.ending != null) {
    ok(composedA.panel.includes(money2(forecastA.scenario.cash.ending)),
      'scenario projected cash matches Forecast.baselineTrajectoryScenario');
  }
  if (forecastA.baseline && forecastA.baseline.debt) {
    ok(composedA.panel.includes(money2(forecastA.baseline.debt.ending)),
      'baseline named debt ending matches Forecast');
    ok(composedA.panel.includes(money2(forecastA.scenario.debt.ending)),
      'scenario named debt ending matches Forecast');
  }
  if (forecastA.delta && forecastA.delta.debt && forecastA.delta.debt.ending != null) {
    ok(composedA.panel.includes(money2(forecastA.delta.debt.ending)),
      'named debt ending delta is copied from Forecast.delta');
  }
  if (forecastA.delta && forecastA.delta.debt && forecastA.delta.debt.interest != null) {
    ok(composedA.panel.includes(money2(forecastA.delta.debt.interest)),
      'named debt interest delta is copied from Forecast.delta');
  }
  ok(forecastA.writesCanonicalState === false && forecastA.actionPermission === 'not-granted',
    'Forecast scenario does not grant writes or action permission');

  const planBefore = JSON.stringify(live.plan);
  const debtsBefore = JSON.stringify(live.debts);
  const paydayBefore = JSON.stringify(F.paydayAllocation(live.plan, live.meta.asOf, {
    debts: live.debts,
    extraFacilities: live.revolvingExtra,
    periods,
  }));
  const budgetBefore = JSON.stringify(F.budgetBreakdown(live.plan, periods, { asOf: live.meta.asOf }));
  const idlePrimary = roadPrimaryHtml(roadIdle);
  const renderedA = page.applyScenarioAndRender(live, periods, pick.id, amountA);
  ok(JSON.stringify(live.plan) === planBefore && JSON.stringify(live.debts) === debtsBefore,
    'applying a scenario does not mutate plan or debts');
  ok(JSON.stringify(F.paydayAllocation(live.plan, live.meta.asOf, {
    debts: live.debts,
    extraFacilities: live.revolvingExtra,
    periods,
  })) === paydayBefore,
    'applying a scenario does not change Forecast.paydayAllocation');
  ok(JSON.stringify(F.budgetBreakdown(live.plan, periods, { asOf: live.meta.asOf })) === budgetBefore,
    'applying a scenario does not change Forecast.budgetBreakdown');
  const roadA = renderedA['planning-road-ahead'].innerHTML;
  ok(/data-trajectory-scenario="ready"/.test(roadA)
    && /data-planning-road-secondary="scenario"/.test(roadA)
    && /data-trajectory-scenario-section="controls"/.test(roadA),
    'road-ahead region renders an active scenario inside the secondary disclosure');
  ok(!/data-planning-road-primary="whatif"/.test(roadA)
    && !/planning-road-whatif-quarantine/.test(roadA)
    && !/What-if: extra payment/.test(roadA),
    'active scenario is not the leftover primary what-if quarantine');
  const roadBaselineStage3 = trajBaseline.months[0].stage3.result.amount;
  ok(roadA.includes(money2(roadBaselineStage3)),
    'road-ahead timeline still shows baseline Forecast stage3, not scenario stage3');
  ok(roadPrimaryHtml(roadA) === idlePrimary,
    'Road Ahead baseline primary markup is unchanged while a scenario is shown');
  if (forecastA.scenario && forecastA.scenario.cash && forecastA.scenario.cash.ending != null) {
    ok(roadA.includes(money2(forecastA.scenario.cash.ending)),
      'live Road Ahead reprints scenario cash from Forecast.baselineTrajectoryScenario');
  }
  if (forecastA.delta && forecastA.delta.cash && forecastA.delta.cash.ending != null) {
    ok(roadA.includes(money2(forecastA.delta.cash.ending)),
      'live Road Ahead reprints Forecast.delta cash, not a page-side subtraction');
  }

  const composedB = page.composeScenario(live, periods, pick.id, amountB);
  if (forecastA.scenario.debt.ending !== forecastB.scenario.debt.ending) {
    ok(composedB.panel.includes(money2(forecastB.scenario.debt.ending))
      && !composedB.panel.includes(money2(forecastA.scenario.debt.ending)),
      'changing the explicit amount changes rendered Forecast scenario output');
  }

  const missingDebt = scenarioWireHarness('', '100.00');
  page.ctx.planningRoadScenarioWire(missingDebt.root, live, periods);
  missingDebt.form.onsubmit({ preventDefault() {} });
  ok(page.ctx.planningScenarioActive === null
    && page.ctx.planningScenarioFormError === 'Select a debt.',
    'Show scenario without a debt does not call a scenario and does not infer one');
  const missingDebtRoad = page.render(live, periods)['planning-road-ahead'].innerHTML;
  ok(/data-trajectory-scenario="form-error"/.test(missingDebtRoad)
    && /data-trajectory-scenario="idle"/.test(missingDebtRoad)
    && !/data-trajectory-scenario="unavailable"/.test(missingDebtRoad),
    'missing debt is a form error with idle preview, not Forecast-unavailable');

  const zeroAmt = scenarioWireHarness(pick.id, '0');
  page.ctx.planningRoadScenarioWire(zeroAmt.root, live, periods);
  zeroAmt.form.onsubmit({ preventDefault() {} });
  ok(page.ctx.planningScenarioActive === null
    && /greater than zero/.test(page.ctx.planningScenarioFormError),
    'zero amount is rejected before Forecast and does not infer a substitute');
  const zeroRoad = page.render(live, periods)['planning-road-ahead'].innerHTML;
  ok(/data-trajectory-scenario="form-error"/.test(zeroRoad)
    && /data-trajectory-scenario="idle"/.test(zeroRoad)
    && !/data-trajectory-scenario="unavailable"/.test(zeroRoad),
    'invalid amount keeps the idle preview, not Forecast-unavailable');

  const wired = scenarioWireHarness(pick.id, '100.00');
  page.ctx.planningRoadScenarioWire(wired.root, live, periods);
  wired.form.onsubmit({ preventDefault() {} });
  ok(page.ctx.planningScenarioActive
    && page.ctx.planningScenarioActive.debtId === pick.id
    && page.ctx.planningScenarioActive.amount === 100,
    'Show scenario requires the explicit eligible debt and whole-cent amount');
  const wiredRoad = page.render(live, periods)['planning-road-ahead'].innerHTML;
  ok(/data-trajectory-scenario="ready"/.test(wiredRoad),
    'wired Show scenario reprints Forecast scenario output');
  wired.clearBtn.onclick();
  const cleared = page.render(live, periods);
  const roadCleared = cleared['planning-road-ahead'].innerHTML;
  ok(/data-trajectory-scenario="idle"/.test(roadCleared)
    && !/data-trajectory-scenario="ready"/.test(roadCleared)
    && !/data-trajectory-scenario="unavailable"/.test(roadCleared),
    'Reset restores baseline-only idle, not Forecast-unavailable');
  ok(/data-trajectory-scenario-form="ready"/.test(roadCleared),
    'controls remain after clear');
  ok(roadPrimaryHtml(roadCleared) === idlePrimary,
    'Clear leaves Road Ahead baseline primary markup unchanged');

  const idleComposed = page.composeScenario(live, periods, null, null);
  ok(/data-trajectory-scenario="idle"/.test(idleComposed.panel),
    'compose with no request is idle, not unavailable');

  const bad = page.composeScenario(live, periods, pick.id, 0);
  ok(/data-trajectory-scenario="unavailable"/.test(bad.panel),
    'zero amount fails closed through Forecast when the page asks anyway');
  const missing = page.composeScenario({ plan: null, debts: [], meta: { asOf: live.meta.asOf }, revolvingExtra: null }, periods, pick.id, 50);
  ok(/data-trajectory-scenario="unavailable"/.test(missing.panel),
    'missing plan fails closed on scenario compare');
  const ineligible = page.composeScenario(live, periods, 'not-an-eligible-debt', 50);
  ok(/data-trajectory-scenario="unavailable"/.test(ineligible.panel),
    'ineligible debt fails closed through Forecast');
}

console.log('\n=== Page contract ===');
{
  const src = stripComments(read('public/planning.js'));
  ok(/App\.register\(renderPlanning\)/.test(src) && /App\.boot\(\{ periods: true \}\)/.test(src), 'planning.js registers on the shared boot and asks for periods');
  ok(!/fetch\(|XMLHttpRequest|require\(|data\.json/.test(src), 'planning.js fetches nothing itself');
  const html = read('public/planning.html');
  ok(/<h1>Forecast<\/h1>/.test(html) && /Road Ahead/.test(html),
    'page h1 identifies as Forecast; trajectory dashboard section is Road Ahead');
  ok(/<div class="kicker">FORECAST<\/div>/.test(html),
    'static page kicker is FORECAST');
  ok(!/baseline walk|published horizon|legacy layout|full table/i.test(html),
    'planning.html avoids DESIGN glossary banned phrases in static copy');
  ok(!/\$\d|\d\.\d\d\b/.test(html.replace(/<meta[^>]*>/g, '')), 'planning.html hardcodes no figure');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  ok(ids.has('planning-road-ahead'),
    'planning.html mounts the Road Ahead region');
  ok(REMOVED_SHELL_IDS.every(id => !ids.has(id)),
    'planning.html has no leftover Road Ahead drawer shells');
  ok(!LEFTOVER_ROAD_DRAWER.test(html),
    'planning.html static copy does not name the leftover drawers');
  ok(/<script src="\/forecast.js"><\/script>\s*<script src="\/planning.js\?v=month-surplus-reconciliation">/.test(html),
    'planning.html loads forecast.js before a cache-busted planning.js so Road Ahead cannot keep a stale decision-story helper');
  ok(!/sports|Seattle|Christmas|couch|painting|Indio|Provincials|insurance|vehicle/i.test(stripComments(read('public/planning.js')) + html),
    'no example list is hardcoded in the page or script');
}

console.log('\n=== Leftover Road Ahead drawers are absent from primary markup/render ===');
{
  const html = read('public/planning.html');
  const liveEl = page.render(live, periods);
  const road = liveEl['planning-road-ahead'].innerHTML;
  const composed = page.composeRoadAhead(live, periods);
  const primary = html + road + composed.lead + composed.stages + composed.breakdown + composed.selected;
  ok(!LEFTOVER_ROAD_DRAWER.test(primary),
    'the seven leftover drawers/what-if titles are absent from Road Ahead primary markup and render');
  ok(!/planning-road-pressure-detail/.test(primary)
    && !/data-road-period-pressure=/.test(primary),
    'in-flow month/pay-period pressure drawer is gone from the waterfall');
  ok(!/planning-road-whatif-quarantine/.test(primary)
    && !/data-planning-road-primary="whatif"/.test(primary),
    'purple what-if quarantine is gone from the primary stack');
  ok(/data-planning-road-secondary="scenario"/.test(road)
    && /data-trajectory-scenario-section="controls"/.test(road),
    'extra-debt scenario remounts as a secondary disclosure after the waterfall');
  ok(REMOVED_SHELL_IDS.every(id => !liveEl[id]),
    'renderPlanning does not fill leftover drawer ids');
  ok(/data-planning-road-waterfall="ready"/.test(road)
    && /data-planning-road-wf="income"/.test(road)
    && /data-planning-road-wf="planned-spending"/.test(road)
    && /data-planning-road-horizon="chips"/.test(road),
    'Budget-waterfall remains the primary Road Ahead');

  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  const liveIncome = traj.months[0] && traj.months[0].income;
  const incomeChunk = (road.split('data-planning-road-wf="income"')[1] || '')
    .split('data-planning-road-wf="')[0];
  const publishedIncomeLines = page.ctx.planningRoadPublishedLines(liveIncome);
  ok(liveIncome && liveIncome.amount != null && liveIncome.identity === 'calendar-dated-income',
    'live calendar-month income rollup is published');
  if (publishedIncomeLines.length) {
    ok(publishedIncomeLines.every(row => row && incomeChunk.includes(row.label)),
      'Planning reprints Forecast-published calendar income line labels and does not invent splits');
    ok(/Total income/.test(incomeChunk) && !/50\s*\/\s*50/.test(incomeChunk),
      'Income reprints the Forecast total beside published lines and does not invent a 50/50 split');
  } else {
    ok(publishedIncomeLines.length === 0,
      'published-lines helper reprints nothing when Forecast published no lines');
    ok(/Total income/.test(incomeChunk)
      && !/\bDale\b/.test(incomeChunk) && !/\bAmanda\b/.test(incomeChunk)
      && !/Seaspan/.test(incomeChunk) && !/Tennis/.test(incomeChunk)
      && !/50\s*\/\s*50/.test(incomeChunk),
      'Income reprints the Forecast total and does not invent Dale/Amanda, Seaspan/Tennis, or a 50/50 split');
  }
  const withLines = JSON.parse(JSON.stringify(traj));
  withLines.months[0].income = {
    amount: liveIncome.amount,
    status: liveIncome.status,
    identity: 'calendar-dated-income',
    lines: [
      { label: 'Published stream A', amount: 100, status: 'confirmed' },
      { label: 'Published stream B', amount: 50, status: 'estimated' },
    ],
  };
  const lined = page.composeRoadAheadTraj(withLines, 'month', withLines.months[0].month, live.meta.asOf);
  const linedIncome = (lined.stages.split('data-planning-road-wf="income"')[1] || '')
    .split('data-planning-road-wf="')[0];
  ok(/Published stream A/.test(linedIncome) && /Published stream B/.test(linedIncome)
    && /Total income/.test(linedIncome)
    && !/\bDale\b/.test(linedIncome) && !/\bAmanda\b/.test(linedIncome),
    'when Forecast publishes named income lines, Planning reprints those labels and still invents none');
}

console.log('\n=== Stage2 commitment named lines reprint on Road Ahead ===');
{
  const waterfallRowLabels = html => [...String(html || '')
    .matchAll(/class="planning-road-wf-label">([^<]*)/g)].map(m => m[1]);
  const plannedBlock = html => (String(html || '')
    .split('data-planning-road-wf="planned-spending"')[1] || '')
    .split('data-planning-road-wf="')[0];
  const planningSrc = stripComments(read('public/planning.js'));
  const inlineSrc = planningSrc.slice(
    planningSrc.indexOf('function planningRoadWaterfallInlineSection('),
    planningSrc.indexOf('function planningRoadWaterfallResultRow('));
  ok(/const named = lines\.length > 0/.test(inlineSrc)
    && /const totalRow = named/.test(inlineSrc)
    && /data-planning-road-wf-lines="\$\{named \? 'named' : 'total-only'\}"/.test(inlineSrc)
    && !/\+ planningRoadWaterfallTotalRow\(title/.test(inlineSrc),
    'inline waterfall helper omits the title total when named lines exist');
  const mockLines = [
    {
      id: 'pub-commit-a',
      label: 'Published commitment A',
      date: '2026-12-09',
      amount: 250,
      status: 'estimated',
    },
    {
      id: 'pub-commit-b',
      label: 'Published commitment B',
      date: '2026-12-25',
      amount: 150,
      status: 'estimated',
    },
  ];
  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  const month = JSON.parse(JSON.stringify(traj.months[0]));
  const withLinesTraj = JSON.parse(JSON.stringify(traj));
  withLinesTraj.months[0].stage2.commitments = {
    amount: 400,
    status: 'estimated',
    lines: mockLines,
  };
  const lined = page.composeRoadAheadTraj(
    withLinesTraj, 'month', withLinesTraj.months[0].month, live.meta.asOf);
  const plannedWf = plannedBlock(lined.stages);
  const plannedSheet = lined.breakdown;
  const linedLabels = waterfallRowLabels(plannedWf);
  ok(/Published commitment A/.test(plannedWf) && /Published commitment B/.test(plannedWf)
    && /planning-road-wf-kicker[\s\S]*Planned spending/.test(plannedWf)
    && linedLabels.includes('Published commitment A')
    && linedLabels.includes('Published commitment B')
    && !linedLabels.includes('Planned spending')
    && !/data-planning-road-wf-row="planned-spending-total"/.test(plannedWf)
    && plannedWf.includes(money2(250))
    && plannedWf.includes(money2(150))
    && !plannedWf.includes(money2(400))
    && /data-planning-road-wf-lines="named"/.test(plannedWf),
    'waterfall reprints named Stage2 lines and omits a same-label Planned spending total');
  ok(/Published commitment A/.test(plannedSheet) && /Published commitment B/.test(plannedSheet)
    && /Dated commitments/.test(plannedSheet)
    && plannedSheet.includes(money2(400))
    && plannedSheet.includes(money2(250))
    && plannedSheet.includes(money2(150)),
    'breakdown sheet reprints mock Stage2 commitment labels and the Dated commitments total');
  ok(plannedWf.includes(longDate('2026-12-09')) && plannedWf.includes(longDate('2026-12-25'))
    && plannedSheet.includes(longDate('2026-12-09')) && plannedSheet.includes(longDate('2026-12-25')),
    'Road Ahead reprints Forecast-published commitment dates when the line model exposes them');
  ok(/data-planning-road-line-id="pub-commit-a"/.test(plannedWf)
    && /data-planning-road-line-id="pub-commit-b"/.test(plannedSheet),
    'Road Ahead carries Forecast-published commitment ids on the reprinted rows');
  ok(/data-planning-road-breakdown="commitments-line-0"/.test(plannedSheet)
    && /data-planning-road-breakdown="commitments-total"/.test(plannedSheet),
    'breakdown keeps the rollup row after named commitment lines');

  const noLinesTraj = JSON.parse(JSON.stringify(traj));
  const noAmt = month.stage2.commitments && month.stage2.commitments.amount != null
    ? month.stage2.commitments.amount : 400;
  noLinesTraj.months[0].stage2.commitments = {
    amount: noAmt,
    status: (month.stage2.commitments && month.stage2.commitments.status) || 'estimated',
  };
  const totalling = page.composeRoadAheadTraj(
    noLinesTraj, 'month', noLinesTraj.months[0].month, live.meta.asOf);
  const noWf = plannedBlock(totalling.stages);
  const noSheet = totalling.breakdown;
  ok(/Planned spending/.test(noWf) && !/Published commitment A/.test(noWf)
    && !/data-planning-road-wf-row="planned-spending-line-/.test(noWf)
    && /data-planning-road-wf-row="planned-spending-total"/.test(noWf)
    && waterfallRowLabels(noWf).includes('Planned spending')
    && noWf.includes(money2(noAmt))
    && /data-planning-road-wf-lines="total-only"/.test(noWf),
    'waterfall Planned spending stays total-only when Stage2 commitments have no lines');
  ok(/Dated commitments/.test(noSheet) && !/Published commitment A/.test(noSheet)
    && !/data-planning-road-breakdown="commitments-line-/.test(noSheet)
    && /data-planning-road-breakdown="commitments"/.test(noSheet),
    'breakdown Dated commitments stays aggregate-only when Forecast published no lines');

  const emptyLinesTraj = JSON.parse(JSON.stringify(traj));
  emptyLinesTraj.months[0].stage2.commitments = {
    amount: 700,
    status: 'estimated',
    lines: [],
  };
  const emptyLined = page.composeRoadAheadTraj(
    emptyLinesTraj, 'month', emptyLinesTraj.months[0].month, live.meta.asOf);
  const emptyWf = plannedBlock(emptyLined.stages);
  ok(/data-planning-road-wf-row="planned-spending-total"/.test(emptyWf)
    && waterfallRowLabels(emptyWf).includes('Planned spending')
    && emptyWf.includes('−' + money2(700))
    && !/Published commitment A/.test(emptyWf)
    && /data-planning-road-wf-lines="total-only"/.test(emptyWf),
    'empty Stage2 commitment lines still show the Planned spending aggregate');

  // Presentation fixture matching the live smoke card: one named Stage2 line
  // plus a same-label Planned spending total must not both be waterfall rows.
  // Amounts here reprint the published mock; they are not a Forecast spec.
  const smokeTraj = JSON.parse(JSON.stringify(traj));
  const smokeMonth = smokeTraj.months.find(m => m.month === '2026-09') || smokeTraj.months[0];
  smokeMonth.stage2 = smokeMonth.stage2 || {};
  smokeMonth.stage2.commitments = {
    amount: 700,
    status: 'estimated',
    lines: [{
      id: 'smoke-named-commit',
      label: 'Burrards team fees',
      date: '2026-09-15',
      amount: 700,
      status: 'estimated',
    }],
  };
  const smokeRoad = page.composeRoadAheadTraj(
    smokeTraj, 'month', smokeMonth.month, live.meta.asOf);
  const smokeWf = plannedBlock(smokeRoad.stages);
  const smokeLabels = waterfallRowLabels(smokeWf);
  ok(smokeLabels.includes('Burrards team fees')
    && smokeWf.includes(longDate('2026-09-15'))
    && smokeWf.includes('−' + money2(700))
    && /planning-road-wf-kicker[\s\S]*Planned spending/.test(smokeWf)
    && /data-planning-road-wf-lines="named"/.test(smokeWf)
    && !smokeLabels.includes('Planned spending')
    && !/data-planning-road-wf-row="planned-spending-total"/.test(smokeWf)
    && smokeLabels.filter(label => label === 'Planned spending').length === 0,
    'named line plus same-label Planned spending total must not both appear as wf rows');

  const itemsTraj = JSON.parse(JSON.stringify(traj));
  itemsTraj.months[0].stage2.commitments = {
    amount: 700,
    status: 'estimated',
    items: [{
      label: 'Burrards team fees',
      date: '2026-09-15',
      amount: 700,
      status: 'estimated',
    }],
  };
  const itemsWf = plannedBlock(page.composeRoadAheadTraj(
    itemsTraj, 'month', itemsTraj.months[0].month, live.meta.asOf).stages);
  ok(waterfallRowLabels(itemsWf).includes('Burrards team fees')
    && !waterfallRowLabels(itemsWf).includes('Planned spending')
    && /data-planning-road-wf-lines="named"/.test(itemsWf),
    'published items[] named lines also omit the same-label Planned spending total');

  const zeroEmptyTraj = JSON.parse(JSON.stringify(traj));
  const zeroMonth = zeroEmptyTraj.months.find(m => m.month === '2027-01') || zeroEmptyTraj.months[0];
  zeroMonth.stage2 = zeroMonth.stage2 || {};
  zeroMonth.stage2.commitments = { amount: 0, status: 'calculated', lines: [] };
  const zeroWf = plannedBlock(page.composeRoadAheadTraj(
    zeroEmptyTraj, 'month', zeroMonth.month, live.meta.asOf).stages);
  ok(/data-planning-road-wf-row="planned-spending-total"/.test(zeroWf)
    && waterfallRowLabels(zeroWf).includes('Planned spending')
    && /data-planning-road-wf-lines="total-only"/.test(zeroWf)
    && zeroWf.includes(money2(0))
    && !/Burrards team fees/.test(zeroWf),
    'empty-lines $0 month keeps the Planned spending aggregate and no named rows');

  if (Array.isArray(traj.payPeriods) && traj.payPeriods[0]) {
    const withPay = JSON.parse(JSON.stringify(traj));
    withPay.payPeriods[0].stage2 = withPay.payPeriods[0].stage2 || {};
    withPay.payPeriods[0].stage2.commitments = {
      amount: 400,
      status: 'estimated',
      lines: mockLines,
    };
    const payKey = withPay.payPeriods[0].payday || withPay.payPeriods[0].id;
    const payLined = page.composeRoadAheadTraj(
      withPay, 'pay-period', payKey, live.meta.asOf);
    const payWf = plannedBlock(payLined.stages);
    ok(/Published commitment A/.test(payWf)
      && /Published commitment B/.test(payWf)
      && !/data-planning-road-wf-row="planned-spending-total"/.test(payWf)
      && !waterfallRowLabels(payWf).includes('Planned spending')
      && !payWf.includes(money2(400)),
      'pay-period waterfall also omits the Planned spending total when named lines exist');
  }

  const dec = traj.months.find(m => m.month === '2026-12');
  const liveLines = dec
    ? page.ctx.planningRoadPublishedLines(dec.stage2 && dec.stage2.commitments)
    : [];
  if (dec && liveLines.length) {
    const liveRoad = page.composeRoadAheadTraj(traj, 'month', '2026-12', live.meta.asOf);
    const livePlanned = plannedBlock(liveRoad.stages);
    ok(liveLines.every(row => liveRoad.stages.includes(row.label)
      && liveRoad.breakdown.includes(row.label)),
      'live December waterfall and breakdown reprint Forecast-published Stage2 commitment labels');
    ok(!/data-planning-road-wf-row="planned-spending-total"/.test(livePlanned)
      && !waterfallRowLabels(livePlanned).includes('Planned spending'),
      'live December does not reprint a Planned spending total row beside named lines');
    const dated = liveLines.filter(row => row && typeof row.date === 'string' && row.date);
    ok(!dated.length || dated.every(row =>
      liveRoad.stages.includes(longDate(row.date))
      && liveRoad.breakdown.includes(longDate(row.date))),
      'live December reprints Forecast-published commitment dates on both Road Ahead surfaces');
  } else {
    ok(true, 'live December Stage2 commitments published no named lines to reprint');
  }

  for (const liveMonth of traj.months || []) {
    if (!liveMonth || !liveMonth.month) continue;
    const liveNamed = page.ctx.planningRoadPublishedLines(
      liveMonth.stage2 && liveMonth.stage2.commitments);
    const liveBlock = plannedBlock(page.composeRoadAheadTraj(
      traj, 'month', liveMonth.month, live.meta.asOf).stages);
    const liveLabels = waterfallRowLabels(liveBlock);
    if (liveNamed.length) {
      ok(liveNamed.every(row => liveLabels.includes(row.label))
        && !liveLabels.includes('Planned spending')
        && !/data-planning-road-wf-row="planned-spending-total"/.test(liveBlock)
        && /data-planning-road-wf-lines="named"/.test(liveBlock),
        `${liveMonth.month} named Stage2 lines do not sit beside a Planned spending total row`);
    } else {
      ok(liveLabels.includes('Planned spending')
        && /data-planning-road-wf-row="planned-spending-total"/.test(liveBlock)
        && /data-planning-road-wf-lines="total-only"/.test(liveBlock)
        && !/data-planning-road-wf-row="planned-spending-line-/.test(liveBlock),
        `${liveMonth.month} with no named lines keeps the Planned spending aggregate`);
    }
  }
}

console.log('\n' + '═'.repeat(60));
if (failures) { console.log(`\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`); process.exit(1); }
console.log('\x1b[32mALL CHECKS PASSED\x1b[0m');
