'use strict';
/* Planning — Your Financial Road Ahead phone-native presentation.
 *
 * Proves the mobile shell is presentation-only: Forecast figures are reprinted,
 * not recomputed; Month/Pay period controls stay authoritative; timeline selection
 * stays semantically accessible; household bottom dock rules are unchanged.
 */
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
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const money2 = n => (n < 0 ? '−$' : '$') + Math.abs(Number(n)).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const longDate = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-CA', { day: 'numeric', month: 'long', year: 'numeric' });
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function mobilePlanningRoadBlock(css) {
  const start = css.indexOf('/* Planning — Road Ahead phone-native shell');
  if (start < 0) return '';
  const end = css.indexOf('@media (min-width:641px) {\n  .planning-list', start);
  return end > start ? css.slice(start, end) : css.slice(start);
}

function loadPage() {
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
    `${helpers}\nfunction planningStubEl(){ const attrs = {}; return { innerHTML: '', textContent: '', querySelector(){return null;}, querySelectorAll(){return [];}, classList:{toggle(){},add(){},remove(){}}, setAttribute(k,v){ attrs[k]=v; }, getAttribute(k){ return attrs[k] != null ? attrs[k] : null; } }; }\nconst $ = id => elements[id] || (elements[id] = planningStubEl());\n${read('public/planning.js')}`,
    ctx, { filename: 'public/planning.js' });
  return {
    ctx,
    render(data, p) {
      for (const k of Object.keys(elements)) delete elements[k];
      elements.asof = {
        textContent: `As at ${data.meta.asOf}`,
        innerHTML: `As at ${data.meta.asOf}`,
      };
      for (const fn of ctx.App.hooks) fn(data, p || null, null);
      return elements;
    },
    composeRoad(data, p, granularity, periodKey, asOf) {
      return ctx.planningRoadAheadHtml(
        ctx.planningTrajectory(data, p || null),
        granularity || 'month',
        periodKey,
        asOf || data.meta.asOf,
      );
    },
    composeRoadTraj(traj, granularity, periodKey, asOf) {
      return ctx.planningRoadAheadHtml(traj, granularity || 'month', periodKey, asOf);
    },
  };
}

/* A Forecast-shaped publication with one funding-gap month, so the gap hero and
 * the gap stage story can be proved without waiting for live data to turn
 * negative. Stage figures are internally consistent the way Forecast's own
 * identity is: stage2 = stage1 − commitments, stage3 = stage2 − extras. */
function gapTrajectory(baseTraj, month) {
  const traj = JSON.parse(JSON.stringify(baseTraj));
  const row = traj.months.find(m => m.month === month);
  row.stage1.result = { amount: 1041, status: 'calculated' };
  row.stage2.commitments = { amount: 1400, status: 'estimated' };
  row.stage2.result = { amount: -359, status: 'calculated' };
  row.stage2.dateOrderResult = { amount: -359, status: 'calculated', identity: 'date-order-month-funding' };
  row.stage3.extras = { amount: 600, status: 'calculated', source: 'plan.defaults.extraDebtMonthly' };
  row.stage3.result = { amount: -959, status: 'calculated' };
  row.stage3.dateOrderResult = { amount: -959, status: 'calculated', identity: 'date-order-month-funding' };
  return { traj, row };
}

const page = loadPage();
const css = read('public/styles.css');
const mobile = mobilePlanningRoadBlock(css);
const planningSrc = stripComments(read('public/planning.js'));

console.log('=== 1. Mobile shell markup and viewport priority ===');
{
  const html = read('public/planning.html');
  ok(/viewport-fit=cover/.test(html), 'planning.html keeps viewport-fit=cover for safe-area');
  ok(/id="planning-road-ahead"/.test(html), 'planning.html keeps road-ahead mount');
  ok(/sitenav-household/.test(html), 'planning reuses incumbent household bottom dock');
  ok(/<script src="\/planning.js\?v=month-surplus-reconciliation">/.test(html),
    'planning.html cache-busts planning.js so live Road Ahead cannot keep the pre-decision-story helper');

  const liveEl = page.render(live, periods);
  const road = liveEl['planning-road-ahead'].innerHTML;
  ok(/data-planning-road-shell="ready"/.test(road), 'render wraps road-ahead in phone-native shell');
  ok(/planning-road-app-head/.test(road), 'shell includes compact page identity header');
  ok(/planning-road-app-eyebrow">FORECAST</.test(road)
    && /<h2 class="planning-road-app-title">Road Ahead</.test(road),
    'identity is FORECAST eyebrow plus Road Ahead title');
  ok(/data-road-lead="period-surplus"|data-road-lead="period-shortfall"|data-road-lead="period-even"|data-road-lead="period-unavailable"/.test(road),
    'hero names this period surplus, shortfall, break-even, or withheld');
  ok(/planning-road-segmented/.test(road)
    && />Month</.test(road) && />Pay period</.test(road)
    && /data-trajectory-funding-granularity="month"/.test(road)
    && /data-trajectory-funding-granularity="pay-period"/.test(road),
    'Month | Pay period segmented control is present (live Forecast seam)');
  ok(/role="tablist"/.test(road) && /role="tab"/.test(road)
    && /aria-selected="true"/.test(road) && /aria-selected="false"/.test(road)
    && /id="planning-road-view-panel"/.test(road) && /role="tabpanel"/.test(road),
    'segmented control uses tablist semantics over the waterfall panel');
  ok(/data-planning-road-waterfall="ready"/.test(road)
    && /data-planning-road-wf="income"/.test(road)
    && /Income received [A-Z][a-z]{2} \d{1,2}–[A-Z][a-z]{2} \d{1,2}/.test(road)
    && /data-planning-road-wf="available-surplus"/.test(road)
    && /data-planning-road-wf="planned-spending"/.test(road)
    && /data-planning-road-wf="after-deductions"/.test(road)
    && /data-planning-road-wf="final"/.test(road),
    'month waterfall reprints calendar income, available surplus, planned spending, and the result');
  ok(/data-planning-road-wf="income"[\s\S]*planning-road-wf-kicker[\s\S]*Income received [A-Z][a-z]{2} \d{1,2}–[A-Z][a-z]{2} \d{1,2}/.test(road)
    && /data-planning-road-wf="available-surplus"[\s\S]*planning-road-wf-kicker[\s\S]*Pay periods closing this month/.test(road)
    && /data-planning-road-wf="planned-spending"[\s\S]*planning-road-wf-kicker[\s\S]*Planned spending/.test(road),
    'month waterfall sections carry kicker chrome — badge plus label');
  const payShell = page.composeRoad(live, periods, 'pay-period').stages;
  ok(/data-planning-road-wf-expand="bills"/.test(payShell)
    && /data-planning-road-wf-expand="household-budget"/.test(payShell)
    && /data-planning-road-wf-expand="bills"[\s\S]*planning-road-wf-chevron/.test(payShell)
    && /data-planning-road-wf-expand="household-budget"[\s\S]*planning-road-wf-chevron/.test(payShell)
    && /data-planning-road-wf="bills"[\s\S]*planning-road-wf-kicker[\s\S]*Bills/.test(payShell)
    && /data-planning-road-wf="obligations"[\s\S]*planning-road-wf-kicker[\s\S]*Required debt payments/.test(payShell)
    && /data-planning-road-wf="household-budget"[\s\S]*planning-road-wf-kicker[\s\S]*Household budget/.test(payShell),
    'pay period waterfall keeps Bills and Household budget expanders');
  ok(/data-planning-road-planned="inline"/.test(road),
    'planned spending is a named inline block');
  const plannedChunk = road.split('data-planning-road-wf="planned-spending"')[1] || '';
  const plannedUntilNext = plannedChunk.split('data-planning-road-wf="')[0];
  ok(!/<details/.test(plannedUntilNext),
    'planned spending is not behind a dropdown/expander');
  ok(/data-planning-road-horizon="chips"/.test(road)
    && /planning-road-horizon-chip-dot-(surplus|gap|withheld|neutral)/.test(road),
    'horizon strip is month/pay chips with surplus/short/withheld dots');
  ok(!/data-road-horizon-stat="surplus"/.test(road)
    && !/data-road-horizon-stat="gap"/.test(road),
    'horizon does not invent surplus/gap counts');
  ok(!/About this view/.test(road) && !/planning-road-app-asof/.test(road),
    'road-ahead shell strips About this view and dense as-of chrome');
  ok(/data-planning-road-primary="lead"/.test(road), 'lead card is in the primary viewport band');
  ok(/data-planning-road-primary="horizon"/.test(road)
    && /data-planning-road-primary="strip"/.test(road),
    'horizon chip strip is a named primary band');
  ok(/data-planning-road-primary="waterfall"/.test(road) && /data-planning-road-stages="waterfall"/.test(road),
    'waterfall is the selected-period primary band');
  ok(/data-planning-road-primary="breakdown"/.test(road) && /data-planning-road-breakdown="sheet"/.test(road),
    'progressive breakdown sheet follows the waterfall');
  const htmlStatic = read('public/planning.html');
  ok(!/baseline walk|published horizon|legacy layout|full table/i.test(htmlStatic),
    'planning.html static copy follows DESIGN glossary');
  const leftoverDrawer = /Pressure signals on this (month|pay period)|What-if: extra payment|Known future costs Atlas is protecting|Monthly cash and debt \(detailed\)|Three-stage funding \(expanded picker\)|All pressure signals in this projection|Debt direction across the projection/;
  ok(!leftoverDrawer.test(htmlStatic) && !leftoverDrawer.test(road),
    'the seven leftover Road Ahead drawers/what-if titles are absent from static markup and live render');
  const horizonAt = road.indexOf('data-planning-road-primary="horizon"');
  const stripAt = road.indexOf('data-planning-road-primary="strip"');
  const waterfallAt = road.indexOf('data-planning-road-primary="waterfall"');
  const leadAt = road.indexOf('data-planning-road-primary="lead"');
  const breakdownAt = road.indexOf('data-planning-road-primary="breakdown"');
  const scenarioAt = road.indexOf('data-planning-road-secondary="scenario"');
  ok(horizonAt >= 0 && stripAt > horizonAt && waterfallAt > stripAt && leadAt > waterfallAt
    && breakdownAt > leadAt,
    'phone order is horizon chips → period title/slice → surplus/deficit hero → waterfall → breakdown');
  ok(scenarioAt > breakdownAt,
    'extra-debt scenario disclosure follows the breakdown, not the primary hero');
  ok(!/data-planning-road-primary="whatif"/.test(road)
    && !/planning-road-whatif-quarantine/.test(road)
    && !/planning-road-pressure-detail/.test(road),
    'primary stack has no leftover what-if quarantine and no in-flow pressure drawer');
  ok(/data-trajectory-scenario-section="controls"/.test(road)
    && /data-planning-road-secondary="scenario"/.test(road),
    'extra-debt scenario remounts as a secondary disclosure');
  ok(!/sustainable|on track|safe to spend|key takeaway|what can you do/i.test(road),
    'road-ahead shell renders no forbidden verdict copy');
  ok(!/baseline walk|published horizon|legacy layout|full table/i.test(road),
    'road-ahead shell avoids DESIGN glossary banned phrases');
  ok(/planning-road-hero-card/.test(road) && /planning-road-waterfall/.test(road),
    'hero card and waterfall treatments render on live shell');
  ok(!/save as plan|save-as-plan/i.test(road),
    'road-ahead has no save-as-plan affordance');
  ok(/planning-road-period-nav/.test(road) && /aria-label="Horizon period navigation"/.test(road),
    'horizon period navigation is a named landmark section');
  ok(!/atlas-card|card-strip|Card badge|purple Card/i.test(road),
    'Road Ahead has no credit-card callout or Card-strip markers');
  ok(!/data-trajectory-funding-granularity="1-15"|data-trajectory-funding-granularity="16-end"/.test(road)
    && !/>1–15</.test(road) && !/>16-end</.test(road) && !/>16–end</.test(road),
    'calendar 1–15 / 16-end slices are not invented; Forecast did not publish them');
}

console.log('\n=== 1b. Identity, freshness, hero, horizon chips, slice control ===');
{
  const road = page.render(live, periods)['planning-road-ahead'].innerHTML;
  ok(/planning-road-freshness/.test(road) && /As at /.test(road),
    'freshness pill is present and states the real opening date');
  ok(/planning-road-app-sub">From your Forecast plan</.test(road),
    'subtitle states figures come from the Forecast plan');
  ok(/planning-road-hero-kind">Surplus</.test(road)
    || /planning-road-hero-kind">Shortfall</.test(road)
    || /planning-road-hero-kind">Break-even</.test(road)
    || /planning-road-hero-kind">Result withheld</.test(road),
    'hero names Surplus, Shortfall, Break-even, or withheld for the selected period');
  ok(/This month · from your Forecast plan/.test(road),
    'default month hero caption names the Forecast month slice');
  ok(!/This pay period · from your Forecast plan/.test(road),
    'default Road Ahead HTML does not caption a pay period This pay period');
  ok(/planning-road-horizon-caption" data-planning-road-horizon="caption">Through /.test(road)
    && /as far as Forecast can currently project\./.test(road),
    'horizon caption names Forecast\'s own published horizon end');
  ok(/planning-road-timeline-year">\d{4}</.test(road)
    && /planning-road-horizon-chip-dot/.test(road)
    && !/planning-road-timeline-bar /.test(road),
    'horizon chips carry a year line and a surplus/short dot, not a mini bar');
  ok(/planning-road-selected-title/.test(road)
    && /data-trajectory-funding-granularity="month"/.test(road),
    'selected period header carries the month title and Month|Pay slice');
  ok(/planning-road-breakdown-summary-label">Full [A-Z][a-z]+ breakdown</.test(road)
    && /planning-road-breakdown-group-title">Income received [A-Z][a-z]{2} \d{1,2}–[A-Z][a-z]{2} \d{1,2}</.test(road)
    && /planning-road-breakdown-group-title">Pay periods closing this month</.test(road),
    'month breakdown names calendar income and available surplus');
  ok(!/This is a preview, not a change/.test(road)
    && !/What-if: extra payment/.test(road),
    'leftover what-if banner and primary title stay absent');
  ok(/planning-road-whatif-preview-head/.test(road)
    && /data-trajectory-scenario="idle"/.test(road),
    'idle extra-debt disclosure keeps the Plan/Preview grid as — not $0');
  ok(/aria-label="[A-Z][a-z]+ \d{4} — Projected (surplus|funding gap|result)/.test(road)
    || /aria-label="\d+ [A-Z][a-z]+ \d{4}[^"]*— Projected/.test(road),
    'chip accessible name is the whole period plus the Forecast result phrase');
}

console.log('\n=== 1c. Selected-period surplus/deficit hero and waterfall reprints ===');
{
  const base = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  const month = base.months.find(m => m.month === '2026-12') ? '2026-12' : base.months[2].month;
  const { traj, row } = gapTrajectory(base, month);
  const road = page.composeRoadTraj(traj, 'month', month, live.meta.asOf);
  const signedBefore = page.ctx.planningRoadSignedMoney(row.stage1.result.amount);
  const signedAfter = page.ctx.planningRoadSignedMoney(row.stage2.dateOrderResult.amount);
  const signedFinal = page.ctx.planningRoadSignedMoney(row.stage3.dateOrderResult.amount);

  ok(/data-road-lead="period-shortfall"/.test(road.lead)
    && road.lead.includes(signedBefore)
    && road.lead.includes('−' + money2(row.stage2.commitments.amount))
    && road.lead.includes(signedAfter)
    && /planning-road-hero-kind">Shortfall</.test(road.lead)
    && /data-planning-road-decision-step="before"/.test(road.lead)
    && /data-planning-road-decision-step="planned"/.test(road.lead)
    && /data-planning-road-decision-step="after"/.test(road.lead)
    && !road.lead.includes(signedFinal),
    'selecting a negative stage2 month leads with before, planned spending, and after — not stage3');
  ok(/This month · from your Forecast plan/.test(road.lead),
    'shortfall hero caption stays on the selected month slice');
  ok(!/NEXT FUNDING GAP|NEXT PRESSURE|See what's behind/.test(road.lead),
    'pressure-first maze is not the primary hero');

  const stages = road.stages;
  ok(stages.includes(page.ctx.planningRoadSignedMoney(row.stage1.result.amount))
    && stages.includes('−' + money2(row.stage2.commitments.amount))
    && stages.includes(signedFinal),
    'waterfall reprints Forecast stage1 result, planned-spending total, and final stage3');
  ok(/data-planning-road-planned="inline"/.test(stages)
    && /data-planning-road-wf="planned-spending"/.test(stages)
    && !/<details/.test((stages.split('data-planning-road-wf="planned-spending"')[1] || '')
      .split('data-planning-road-wf="')[0]),
    'planned spending is listed inline and not inside a details expander');
  ok(/data-planning-road-wf="extra-debt"/.test(stages)
    && stages.includes('−' + money2(row.stage3.extras.amount)),
    'non-zero extra debt payments reprint inline so the final matches stage3');

  const stage1To2 = Math.round((row.stage1.result.amount - row.stage2.result.amount) * 100) / 100;
  const stage2To3 = Math.round((row.stage2.result.amount - row.stage3.result.amount) * 100) / 100;
  ok(stage1To2 === row.stage2.commitments.amount && stage2To3 === row.stage3.extras.amount,
    'waterfall components reconcile with the stage-to-stage drop in Forecast\'s own results',
    `${stage1To2} / ${stage2To3}`);

  ok(/data-planning-road-wf="final"[\s\S]*data-road-result-sign="gap"/.test(stages)
    && /Final shortfall/.test(stages),
    'final row is named shortfall and carries the Forecast sign');

  const surplusMonth = base.months.find(m => m.stage2 && m.stage2.dateOrderResult
    && isFinite(m.stage2.dateOrderResult.amount) && m.stage2.dateOrderResult.amount > 0);
  if (surplusMonth) {
    const surplus = page.composeRoadTraj(base, 'month', surplusMonth.month, live.meta.asOf);
    ok(/data-road-lead="period-surplus"/.test(surplus.lead)
      && /data-road-result-sign="surplus"/.test(surplus.stages)
      && !/sustainable|well done|great|healthy/i.test(surplus.stages + surplus.lead),
      'surplus periods use the identical anatomy with no praise copy');
  }

  const withheldMonth = JSON.parse(JSON.stringify(base));
  const target = withheldMonth.months[1];
  target.stage2.commitments = { status: 'unavailable', reason: 'Forecast withheld this component.' };
  target.stage2.result = { status: 'unavailable', reason: 'Forecast withheld this stage.' };
  target.stage2.dateOrderResult = { status: 'unavailable', reason: 'Forecast withheld this stage.' };
  target.stage3.result = { status: 'unavailable', reason: 'Forecast withheld this stage.' };
  target.stage3.dateOrderResult = { status: 'unavailable', reason: 'Forecast withheld this stage.' };
  const withheld = page.composeRoadTraj(withheldMonth, 'month', target.month, live.meta.asOf);
  const plannedBlock = (withheld.stages.split('data-planning-road-wf="planned-spending"')[1] || '')
    .split('data-planning-road-wf="')[0];
  ok(/planning-road-amount-unavailable/.test(plannedBlock)
    && /—/.test(plannedBlock)
    && !/\$0\.00/.test(plannedBlock),
    'a withheld planned-spending total stays an em-dash, not $0');
  ok(/data-road-lead="period-unavailable"/.test(withheld.lead)
    && /data-planning-road-decision-step="after"/.test(withheld.lead)
    && /not counted as \$0/.test(withheld.lead)
    && /data-planning-road-secondary="debt-strategy"/.test(withheld.stages),
    'a withheld stage2 result fails closed on the primary story and stage3 stays secondary');
}

console.log('\n=== 1d. Trust badges cover every figure the stage card reprints ===');
{
  // Frame 03 stage copy reprints the stage result and the component Forecast
  // subtracts at that stage. Both appear on one card carrying one badge, so
  // that badge must never be stronger than any figure on it. Forecast's own
  // weaker-of rule is what makes that true; this asserts it rather than
  // assuming it, because an estimate must never read as confirmed.
  const rank = { calculated: 3, confirmed: 3, estimated: 2, unavailable: 1 };
  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  let stage2Holds = true;
  let stage3Holds = true;
  let checked = 0;
  for (const month of traj.months || []) {
    const commitments = month.stage2 && month.stage2.commitments;
    const extras = month.stage3 && month.stage3.extras;
    if (commitments && commitments.status && month.stage2.result.status) {
      checked++;
      if (rank[month.stage2.result.status] > rank[commitments.status]) stage2Holds = false;
    }
    if (extras && extras.status && month.stage3.result.status) {
      if (rank[month.stage3.result.status] > rank[extras.status]) stage3Holds = false;
    }
  }
  ok(checked > 0 && stage2Holds,
    'the stage 2 badge is never stronger than the planned-spending figure its copy reprints',
    `${checked} months checked`);
  ok(stage3Holds,
    'the stage 3 badge is never stronger than the extra-payment figure its copy reprints');

  const estimatedMonth = (traj.months || []).find(m => m.stage1
    && m.stage1.result && m.stage1.result.status === 'estimated');
  if (estimatedMonth) {
    const road = page.composeRoadTraj(traj, 'month', estimatedMonth.month, live.meta.asOf);
    ok(road.stages.includes(page.ctx.planningRoadSignedMoney(estimatedMonth.stage1.result.amount))
      && /planning-road-trust-estimated/.test(road.stages)
      && />Estimated</.test(road.stages)
      && !/planning-road-wf-about/.test(road.stages),
      'an estimated waterfall reprints the amount with its Estimated chip and no about prefix');
    ok(/planning-road-trust-estimated/.test(road.lead) && />Estimated</.test(road.lead),
      'the hero marks its estimated figure Estimated on Road Ahead');
  } else {
    ok(true, 'live opening publishes no estimated stage to badge-check');
  }
}

console.log('\n=== 2. Responsive CSS — snap timeline, touch targets, vertical stages ===');
{
  ok(mobile.length > 200, 'phone-native road-ahead CSS block is present');
  ok(/scroll-snap-type:\s*x mandatory/.test(mobile),
    'trajectory strip uses horizontal scroll snap on phone widths');
  ok(/min-height:\s*44px/.test(mobile),
    'mobile road-ahead controls meet touch-target floor');
  ok(/#planning > h1[\s\S]*display:\s*none/.test(mobile),
    'duplicate desktop Planning h1 is hidden on phone');
  ok(/planning-road-selected[\s\S]*flex-direction:\s*column/.test(mobile)
    || /planning-road-stages[\s\S]*flex-direction:\s*column/.test(mobile),
    'three-stage funding stacks vertically in the selected-period story');
  ok(!/planning-road-whatif-quarantine/.test(css)
    && !/\.planning-road-disclosure/.test(css)
    && !/\.planning-road-pressure-detail/.test(css),
    'leftover drawer and what-if quarantine styling is gone');
  ok(/planning-road-trust-estimated/.test(css),
    'estimated trust chip uses amber presentation class');
  ok(/--road-trust-confirmed/.test(css) && /--road-gap/.test(css),
    'Road Ahead uses DESIGN §9 trust and status tokens');
  ok(/planning-road-trust-planned/.test(css),
    'planned trust chip uses blue presentation class');
  ok(/data-trajectory-funding-result-sign="gap"/.test(css),
    'stage results expose Forecast sign for presentation-only gap/surplus styling');
  ok(/body:has\(#planning\)[\s\S]*\.site-head-row \.brand[\s\S]*display:\s*none/.test(mobile),
    'planning phone view trims masthead brand chrome');
  ok(/body:has\(#planning\)[\s\S]*\.site-head-row \.chip[\s\S]*display:\s*none/.test(mobile),
    'planning phone view hides the dense site-head as-of chip');
  ok(/planning-road-spine[\s\S]*flex-direction:\s*column/.test(css)
    || /planning-road-spine[\s\S]*flex-direction:\s*column/.test(mobile),
    'Frame 03 stage spine is a vertical column');
  ok(/planning-road-segmented[\s\S]*flex-wrap:\s*nowrap/.test(mobile)
    || /planning-road-granularity[\s\S]*flex-wrap:\s*nowrap/.test(mobile),
    'Month|Pay segmented control stays on one row at phone width');
  ok(/\.planning-road-segmented \.planning-trajectory-granularity-btn\[aria-selected="true"\]/.test(mobile),
    'the raised active segment follows aria-selected, the state the tablist exposes');
  ok(/\.planning-road-hero-cta \{[\s\S]*min-height:\s*48px/.test(css),
    'hero CTA is a full-size tap target');
  ok(/\.planning-road-nav-btn \{[\s\S]*min-height:\s*40px/.test(css),
    'pager chevrons keep a real tap target');
  ok(/\.planning-road-timeline-plot::before \{[\s\S]*top:\s*50%/.test(css)
    && /\.planning-road-timeline-bar-surplus \{[\s\S]*bottom:\s*50%/.test(css)
    && /\.planning-road-timeline-bar-gap \{[\s\S]*top:\s*50%/.test(css),
    'DESIGN §8 baseline hairline gives the chip bars a shared zero, signed by direction');
  ok(/\.planning-road-projected-result-gap \{[\s\S]*var\(--road-gap-tint\)/.test(css)
    && /\.planning-road-projected-result-surplus \{[\s\S]*var\(--road-surplus-tint\)/.test(css),
    'the projected-result bar tints from the DESIGN §9 status tints');
  ok(/--road-gap-tint:/.test(css) && /--road-surplus-tint:/.test(css)
    && /--road-est-tint:/.test(css) && /--road-unav-tint:/.test(css),
    'DESIGN §9 tints exist as tokens, scoped to Road Ahead');
  ok(/:root\[data-theme="dark"\] \.planning-road-shell \{[\s\S]*--road-gap-tint:/.test(css),
    'dark is a re-tuned token swap, not an inversion');
  ok(/\.planning-road-stage-card \{/.test(css) && /\.planning-road-stage-pill \{/.test(css)
    && /\.planning-road-breakdown-group-title \{/.test(css)
    && /\.planning-road-freshness \{/.test(css),
    'Frame chrome — stage card, delta pill, breakdown group heads, freshness pill — is styled');
  ok(/font-variant-numeric:\s*tabular-nums/.test(css),
    'money is set with tabular numerals');
  ok(/\.planning-road-wf-income \.planning-road-wf-kicker \{[\s\S]*background:\s*var\(--road-surplus-tint\)/.test(css)
    && /\[data-planning-road-wf="bills"\] \.planning-road-wf-kicker \{[\s\S]*background:\s*var\(--road-gap-tint\)/.test(css)
    && /\[data-planning-road-wf="obligations"\] \.planning-road-wf-kicker \{[\s\S]*background:\s*var\(--road-est-tint\)/.test(css)
    && /\[data-planning-road-wf="household-budget"\] \.planning-road-wf-kicker \{[\s\S]*background:\s*var\(--road-surplus-tint\)/.test(css)
    && /\[data-planning-road-wf="planned-spending"\] \.planning-road-wf-kicker[\s\S]*background:\s*var\(--road-unav-tint\)/.test(css)
    && /\[data-planning-road-wf="extra-debt"\] \.planning-road-wf-kicker[\s\S]*background:\s*var\(--road-unav-tint\)/.test(css),
    'every waterfall section kicker uses a tinted header bar, matching Income/Bills');
  ok(/\.planning-road-wf-chevron \{/.test(css)
    && /\.planning-road-wf-expand\[open\] \.planning-road-wf-chevron \{/.test(css)
    && /\.planning-road-wf-summary \{[\s\S]*min-height:\s*48px/.test(css),
    'expander chevron and 48px summary tap target are styled');
  ok(/\.planning-road-wf-row \{[\s\S]*flex-wrap:\s*wrap/.test(css)
    && /\.planning-road-wf-label \{[\s\S]*flex:\s*1 1 11rem/.test(css)
    && !/\.planning-road-wf-label \{[\s\S]{0,180}max-width:/.test(css),
    'waterfall labels take remaining row space and are not max-width cramped');
  ok(/\.planning-road-wf-result \{[\s\S]*flex-wrap:\s*wrap/.test(css)
    && /\.planning-road-wf-result-label \{[\s\S]*flex:\s*1 1 16rem/.test(css)
    && /\.planning-road-wf-result-value \{[\s\S]*white-space:\s*nowrap/.test(css),
    'long result titles wrap the row so the amount stacks instead of squeezing the label');
  ok(/\.planning-road-wf-result \{\s*flex-direction:\s*column/.test(mobile),
    'phone Road Ahead stacks surplus/final labels above the amount');
}

console.log('\n=== 3. Forecast reprints unchanged — no page-side trajectory math ===');
{
  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  const month = traj.months[0];
  const road = page.composeRoad(live, periods, 'month', month.month, live.meta.asOf);
  const signed = page.ctx.planningRoadSignedMoney(month.stage2.dateOrderResult.amount);
  ok(new RegExp(`data-road-timeline-period="${month.month}"[\\s\\S]*data-road-timeline-sign="(surplus|gap|neutral|withheld)"`).test(road.timeline)
    || road.timeline.includes(`data-road-timeline-period="${month.month}"`),
    'horizon chip for the first month is present with a Forecast-derived sign');
  ok(road.lead.includes(signed)
    && road.lead.includes(page.ctx.planningRoadSignedMoney(month.stage1.result.amount))
    && /data-road-lead="period-/.test(road.lead),
    'hero reprints Forecast stage1 and stage2 for the selected month');
  ok(road.selected.includes(money2(month.stage3.dateOrderResult.amount)),
    'selected-period panel copies the Forecast date-order stage3 amount');
  const shell = page.render(live, periods)['planning-road-ahead'].innerHTML;
  ok(shell.includes(money2(month.stage3.dateOrderResult.amount)),
    'live shell reprints Forecast date-order stage3 without alternate arithmetic');

  const roadBlock = planningSrc.split('function planningRoadAheadScrollSelectedTimeline')[0]
    .split('function planningRoadAheadWireSelection')[0];
  ok(!/stage1Amount|stage2Amount|stage3Amount|baselineTrajectoryMonthFunding/.test(roadBlock),
    'road-ahead presentation block does not recompute stage totals');
  ok(!/\+\s*period\.stage|stage\d\.result\.amount\s*[-+*/]/.test(
    planningSrc.split('function planningRoadAheadHtml')[1].split('function planningTrajectoryFundingHtml')[0]),
    'road-ahead helpers do not derive new amounts from stage results');
  const horizonFn = planningSrc.match(
    /function planningRoadAheadHorizonCountsHtml\([\s\S]*?\n\}/);
  ok(horizonFn && !/surplus\s*\+|gap\s*\+|data-road-horizon-kind/.test(horizonFn[0]),
    'horizon counts helper does not aggregate periods into surplus/gap tallies');
  ok(/data-road-result-sign="(gap|surplus|neutral)"/.test(shell),
    'waterfall amounts expose Forecast sign for gap/surplus presentation CSS');
  const wfShell = (shell.split('data-planning-road-waterfall="ready"')[1] || '')
    .split('planning-road-breakdown-band')[0];
  const leadShell = (shell.split('data-planning-road-primary="lead"')[1] || '')
    .split('planning-road-stages')[0];
  ok(!/planning-road-trust-calculated/.test(wfShell)
    && !/planning-road-wf-about/.test(wfShell)
    && !/>Calculated</.test(wfShell),
    'Road Ahead waterfall does not render Calculated or about chrome');
  ok(!/planning-road-trust-calculated/.test(leadShell)
    && !/>Calculated</.test(leadShell),
    'Road Ahead hero does not render a Calculated chip');
  ok(!/planning-road-trust-calculated[^>]*>Confirmed</.test(shell),
    'Calculated chip label is never Confirmed');
  const chipFn = planningSrc.match(/function planningRoadTrustChip\([\s\S]*?\n\}/);
  ok(chipFn && /calculated: \{ cls: 'planning-road-trust-calculated', label: 'Calculated' \}/.test(chipFn[0]),
    'trust map still sends Forecast calculated to Calculated for non-waterfall reprints');
  ok(chipFn && !/calculated:[^}]*Confirmed/.test(chipFn[0]),
    'trust map does not alias calculated to Confirmed');
  const wfChipFn = planningSrc.match(/function planningRoadWaterfallTrustChip\([\s\S]*?\n\}/);
  ok(wfChipFn && /status === 'calculated'/.test(wfChipFn[0]) && !/status === 'estimated'/.test(wfChipFn[0]),
    'waterfall chip helper suppresses only Calculated; Estimated is always shown');
}

console.log('\n=== 4. Granularity, accessibility, and fail-closed presentation ===');
{
  const rendered = page.render(live, periods)['planning-road-ahead'].innerHTML;
  ok(/data-trajectory-funding-granularity="month"/.test(rendered)
    && /data-trajectory-funding-granularity="pay-period"/.test(rendered),
    'Month and Pay period toggles are both rendered');
  ok(/aria-pressed="true"/.test(rendered) && /aria-pressed="false"/.test(rendered),
    'granularity buttons expose pressed state for assistive tech');
  ok(/aria-pressed=/.test(rendered) && /planning-road-timeline-btn/.test(rendered),
    'timeline period pickers remain buttons with aria-pressed, not table role=button');
  ok(!/role="button"/.test(rendered) || !/<table[\s\S]*role="button"/.test(rendered),
    'road-ahead strip does not replace table semantics with role=button');

  const withheld = page.composeRoad(
    { plan: null, debts: [], meta: { asOf: live.meta.asOf }, revolvingExtra: null },
    periods, 'month', null, live.meta.asOf);
  ok(/unavailable|Withheld|Forecast unavailable/.test(withheld.lead + withheld.timeline),
    'unavailable trajectory still fails closed in the mobile shell path');
  const roadBlock = planningSrc.split('function planningRoadAheadScrollSelectedTimeline')[0];
  ok(/planning-road-amount-unavailable[\s\S]*—/.test(roadBlock)
    || /aria-label="Unavailable">—</.test(roadBlock),
    'unavailable amounts reprint as em dash, not $0');
}

console.log('\n=== 5. Bottom dock — incumbent safe-area rules untouched ===');
{
  const dockBlock = /@media \(max-width:640px\) \{[\s\S]*?\.sitenav-household a\[aria-current\]::before/.exec(css);
  ok(dockBlock && /env\(safe-area-inset-bottom/.test(dockBlock[0]),
    'household dock still accounts for iOS safe-area inset');
  ok(/padding-bottom:calc\(var\(--nav-dock-height\)/.test(css),
    'body padding still reserves space so the dock does not cover content');
}

console.log('\n=== 6. Desktop presentation preserved ===');
{
  ok(/@media \(min-width:641px\)[\s\S]*\.planning-road-app-head \{ display: none; \}/.test(css),
    'compact app head is phone-only; desktop keeps incumbent page chrome');
  ok(/@media \(min-width:641px\)[\s\S]*grid-template-columns: repeat\(3/.test(css),
    'desktop road-ahead selected period keeps three-column stage grid');
}

console.log('\n=== 7. Cross-year timeline chip labels (Fable trajectory strip) ===');
{
  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  const monthYears = new Set((traj.months || []).map(m => String(m.month).slice(0, 4)));
  ok(monthYears.size > 1,
    'live baseline trajectory spans multiple calendar years for chip-label proof');
  const road = page.composeRoad(live, periods, 'month', '2027-01', live.meta.asOf);
  const chipText = (timeline, key) => {
    const m = new RegExp(`data-road-timeline-period="${key}"[\\s\\S]*?planning-road-timeline-label">([^<]+)<[\\s\\S]*?planning-road-timeline-year">([^<]*)<`)
      .exec(timeline);
    return m ? { label: m[1], year: m[2] } : null;
  };
  const jan27 = chipText(road.timeline, '2027-01');
  const aug26 = chipText(road.timeline, '2026-08');
  const dec26 = chipText(road.timeline, '2026-12');
  ok(jan27 && jan27.label === 'Jan' && jan27.year === '2027',
    'every month chip states its own calendar year, so Jan 2027 never reads as Jan 2026',
    jan27 ? `${jan27.label} ${jan27.year}` : 'missing');
  ok(dec26 && dec26.label === 'Dec' && dec26.year === '2026',
    'the month before the year turns carries its own year on the same chip',
    dec26 ? `${dec26.label} ${dec26.year}` : 'missing');
  ok(aug26 && aug26.year === '2026',
    'anchor-year chips carry a year too, so no chip depends on its neighbours');

  // Unique chip identity is the property PR #341 fixed. The per-chip year line
  // is now what carries it, for every chip rather than only later years.
  const chipIdentities = timeline => [...timeline.matchAll(
    /planning-road-timeline-label">([^<]+)<\/span>\s*<span class="planning-road-timeline-year">([^<]*)</g)]
    .map(m => `${m[1]} ${m[2]}`);
  const monthChips = chipIdentities(road.timeline);
  ok(monthChips.length === traj.months.length,
    'one chip per published month', `${monthChips.length}/${traj.months.length}`);
  ok(new Set(monthChips).size === monthChips.length,
    'no two month chips read the same on the strip', monthChips.join(' | '));

  const payRoad = page.composeRoad(live, periods, 'pay-period', '2027-07-30', live.meta.asOf);
  const payChip = chipText(payRoad.timeline, '2027-07-30');
  ok(payChip && payChip.label.includes('\u2013') && payChip.year === '2027',
    'pay-period chips are date-range labelled and carry the year (DESIGN Month <-> Pay Period)',
    payChip ? `${payChip.label} ${payChip.year}` : 'missing');
  const payChips = chipIdentities(payRoad.timeline);
  ok(payChips.length === traj.payPeriods.length
    && new Set(payChips).size === payChips.length,
    'no two pay-period chips read the same on the strip', `${payChips.length} chips`);

  const chipFn = planningSrc.match(/function planningRoadAheadChipLabel\([\s\S]*?\n\}/);
  ok(chipFn && !/yearContext/.test(chipFn[0]),
    'chip label helper no longer needs neighbour context to stay unambiguous');
  ok(/function planningRoadAheadChipYear\(/.test(planningSrc)
    && /function planningRoadAheadChipAccessibleLabel\(/.test(planningSrc),
    'chip year and accessible-label helpers are present for static contract check');
  ok(!/planningRoadAheadTimelineYearContext|planningRoadAheadChipYearSuffix/.test(planningSrc),
    'the superseded year-suffix mechanism is gone — one authority for chip identity');
}

console.log('\n=== 8. Timeline scroll containment (no window jump) ===');
{
  const road = page.render(live, periods)['planning-road-ahead'].innerHTML;
  ok(!/As of\s+As at/i.test(road) && !/planning-road-app-asof-label/.test(road),
    'road-ahead header does not prefix a second As of label onto As at …');

  const scrollFnMatch = planningSrc.match(
    /function planningRoadAheadScrollSelectedTimeline\([\s\S]*?\n\}/);
  const scrollFn = scrollFnMatch ? scrollFnMatch[0] : '';
  ok(scrollFn.length > 80, 'scroll helper is present for static contract check');
  ok(!/scrollIntoView/.test(scrollFn),
    'selected timeline scroll does not call window scrollIntoView after renderPlanning');
  ok(/planning-road-timeline|closest\(/.test(scrollFn)
    && /scrollTo|scrollLeft/.test(scrollFn),
    'scroll helper moves the horizontal timeline strip only');
}

console.log('\n=== 9. Tablist keyboard switching (Systems Review blocker 1) ===');
{
  const fakeTab = (id, selected) => ({
    getAttribute(name) {
      if (name === 'data-trajectory-funding-granularity') return id;
      if (name === 'aria-selected') return selected ? 'true' : 'false';
      return null;
    },
  });
  const monthSelected = [fakeTab('month', true), fakeTab('pay-period', false)];
  const paySelected = [fakeTab('month', false), fakeTab('pay-period', true)];
  const next = page.ctx.planningRoadAheadTablistNextGranularity;
  ok(typeof next === 'function', 'tablist key helper is on the planning page');
  ok(next(monthSelected, 'ArrowRight') === 'pay-period'
    && next(monthSelected, 'End') === 'pay-period',
    'from Month, ArrowRight and End name the Pay period tab');
  ok(next(monthSelected, 'ArrowLeft') === 'pay-period',
    'from Month, ArrowLeft wraps to Pay period');
  ok(next(paySelected, 'ArrowLeft') === 'month'
    && next(paySelected, 'Home') === 'month',
    'from Pay period, ArrowLeft and Home name the Month tab');
  ok(next(paySelected, 'ArrowRight') === 'month',
    'from Pay period, ArrowRight wraps to Month');
  ok(next(monthSelected, 'Tab') == null && next(monthSelected, 'Enter') == null,
    'Tab and Enter are not captured as tablist movement keys');

  const monthBtn = {
    attrs: {
      'data-trajectory-funding-granularity': 'month',
      'aria-selected': 'true',
    },
    onclick: null,
    getAttribute(k) { return this.attrs[k] != null ? String(this.attrs[k]) : null; },
  };
  const payBtn = {
    attrs: {
      'data-trajectory-funding-granularity': 'pay-period',
      'aria-selected': 'false',
    },
    onclick: null,
    getAttribute(k) { return this.attrs[k] != null ? String(this.attrs[k]) : null; },
  };
  const tabs = [monthBtn, payBtn];
  const tablist = {
    onkeydown: null,
    querySelectorAll() { return tabs; },
  };
  const root = {
    querySelector(sel) { return String(sel).includes('tablist') ? tablist : null; },
    querySelectorAll(sel) {
      if (String(sel).includes('data-road-select-period')) return [];
      if (String(sel).includes('data-trajectory-funding-granularity')) return tabs;
      return [];
    },
  };
  const els = page.render(live, periods);
  const before = els['planning-road-ahead'].innerHTML;
  ok(/data-trajectory-funding-granularity="month" aria-selected="true"/.test(before),
    'live shell starts on the Month tab');
  page.ctx.planningRoadAheadWireSelection(root, live, periods);
  ok(typeof tablist.onkeydown === 'function',
    'the tablist receives a keydown handler');
  let prevented = false;
  tablist.onkeydown({
    key: 'ArrowRight',
    preventDefault() { prevented = true; },
  });
  const after = els['planning-road-ahead'].innerHTML;
  ok(prevented, 'ArrowRight is consumed so the page does not scroll');
  ok(/data-trajectory-funding-granularity="pay-period" aria-selected="true"/.test(after)
    && /data-trajectory-funding-granularity="month" aria-selected="false"/.test(after),
    'ArrowRight switches the rendered view to Pay period');
  monthBtn.onclick();
  const reset = els['planning-road-ahead'].innerHTML;
  ok(/data-trajectory-funding-granularity="month" aria-selected="true"/.test(reset),
    'Month click restores the default tab after the keyboard proof');
}

console.log('\n=== 10. Month-only pressure CTA fails closed in Pay period view (blocker 2) ===');
{
  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  const asOf = live.meta.asOf;
  const asOfMonth = String(asOf).slice(0, 7);
  const signalMonth = (traj.months || []).map(m => m.month)
    .find(month => month && month > asOfMonth);
  const selectedPay = (traj.payPeriods || []).find(p => {
    const startMonth = String(p.start || p.payday || '').slice(0, 7);
    return startMonth && startMonth === asOfMonth;
  }) || (traj.payPeriods || [])[0];
  const selectedKey = selectedPay ? (selectedPay.payday || selectedPay.id) : null;
  ok(signalMonth && selectedKey,
    'fixture has a later published month and a selected opening pay period');

  const clearGap = period => {
    if (period && period.stage3 && period.stage3.result
      && isFinite(Number(period.stage3.result.amount))
      && Number(period.stage3.result.amount) < 0) {
      period.stage3.result = Object.assign({}, period.stage3.result, { amount: 0 });
    }
    if (period && period.stage3 && period.stage3.dateOrderResult
      && isFinite(Number(period.stage3.dateOrderResult.amount))
      && Number(period.stage3.dateOrderResult.amount) < 0) {
      period.stage3.dateOrderResult = Object.assign({}, period.stage3.dateOrderResult, { amount: 0 });
    }
  };
  const pressureTraj = JSON.parse(JSON.stringify(traj));
  (pressureTraj.months || []).forEach(clearGap);
  (pressureTraj.payPeriods || []).forEach(clearGap);
  pressureTraj.pressure = {
    status: 'ready',
    signals: [{
      kind: 'month-cash-decline',
      month: signalMonth,
      amount: 250,
      trust: 'calculated',
    }],
  };

  const monthParts = {
    '01': 'January', '02': 'February', '03': 'March', '04': 'April',
    '05': 'May', '06': 'June', '07': 'July', '08': 'August',
    '09': 'September', '10': 'October', '11': 'November', '12': 'December',
  };
  const signalLabel = `${monthParts[signalMonth.slice(5, 7)]} ${signalMonth.slice(0, 4)}`;
  const fromY = Number(asOfMonth.slice(0, 4));
  const fromM = Number(asOfMonth.slice(5, 7));
  const toY = Number(signalMonth.slice(0, 4));
  const toM = Number(signalMonth.slice(5, 7));
  const monthDelta = (toY - fromY) * 12 + (toM - fromM);
  const expectedRelative = monthDelta <= 0
    ? 'this month'
    : monthDelta === 1 ? 'next month' : `in ${monthDelta} months`;

  const payLead = page.composeRoadTraj(
    pressureTraj, 'pay-period', selectedKey, asOf).lead;
  const payPeriod = (pressureTraj.payPeriods || []).find(p => (p.payday || p.id) === selectedKey);
  const payResult = payPeriod && payPeriod.stage3 && payPeriod.stage3.result;
  ok(/data-road-lead="period-surplus"|data-road-lead="period-shortfall"|data-road-lead="period-even"|data-road-lead="period-unavailable"/.test(payLead),
    'Pay period hero reprints that pay period\'s Forecast result, not a pressure month');
  ok(!/NEXT PRESSURE|NEXT FUNDING GAP/.test(payLead),
    'Pay period hero is not the pressure-first maze');
  const payAfter = payPeriod && payPeriod.stage2 && payPeriod.stage2.result;
  if (payAfter && payAfter.amount != null && isFinite(Number(payAfter.amount))) {
    ok(payLead.includes(page.ctx.planningRoadSignedMoney(payAfter.amount))
      && /data-planning-road-decision-step="before"/.test(payLead)
      && /data-planning-road-decision-step="after"/.test(payLead),
      'Pay period hero reprints Forecast stage2 for the selected pay period');
  }
  ok(!new RegExp(`data-road-select-period="${selectedKey}"`).test(payLead),
    'hero has no period-select CTA that would jump the waterfall');
  ok(!/planning-road-hero-cta/.test(payLead),
    'primary waterfall hero has no See-what\'s-behind CTA');

  const monthLead = page.composeRoadTraj(
    pressureTraj, 'month', asOfMonth, asOf).lead;
  const asOfRow = (pressureTraj.months || []).find(m => m.month === asOfMonth)
    || (pressureTraj.months || [])[0];
  ok(/data-road-lead="period-/.test(monthLead)
    && asOfRow && monthLead.includes(page.ctx.planningRoadSignedMoney(asOfRow.stage2.dateOrderResult.amount)),
    'Month view hero reprints the selected month Forecast date-order result, not the pressure month CTA');

  const dated = JSON.parse(JSON.stringify(pressureTraj));
  const datedPay = (dated.payPeriods || []).find(p => p.start && p.end && p.start.slice(0, 7) === signalMonth)
    || (dated.payPeriods || []).find(p => p.start && p.end);
  ok(datedPay && datedPay.start && datedPay.end,
    'dated-signal proof has a pay period with a published range');
  const otherPay = (dated.payPeriods || []).find(p => (p.payday || p.id) !== (datedPay.payday || datedPay.id));
  const datedLead = page.composeRoadTraj(
    dated, 'pay-period', otherPay ? (otherPay.payday || otherPay.id) : selectedKey, asOf).lead;
  const otherResult = otherPay && otherPay.stage2 && otherPay.stage2.result;
  ok(/data-road-lead="period-/.test(datedLead),
    'a pressure signal does not replace the selected pay-period waterfall hero');
  if (otherResult && otherResult.amount != null && isFinite(Number(otherResult.amount))) {
    ok(datedLead.includes(page.ctx.planningRoadSignedMoney(otherResult.amount)),
      'hero stays on the selected pay period Forecast result when pressure names another date');
  }
}

console.log('\n=== 1g. Stage 2/3 break-even narrative — $0 running total is not called surplus ===');
{
  const page = loadPage();
  const narrative = page.ctx.planningRoadStageNarrative;
  const monthName = 'March';
  const period = {
    stage1: { result: { amount: 500, status: 'calculated' } },
    stage2: {
      commitments: { amount: 500, status: 'calculated' },
      result: { amount: 0, status: 'calculated' },
      dateOrderResult: { amount: 0, status: 'calculated' },
    },
    stage3: {
      extras: { amount: 200, status: 'calculated' },
      result: { amount: 0, status: 'calculated' },
      dateOrderResult: { amount: 0, status: 'calculated' },
    },
  };
  const stage2Note = narrative(period, 2, 'month', monthName);
  const stage3Note = narrative(period, 3, 'month', monthName);
  ok(!/surplus/i.test(stage2Note),
    'stage 2 note for a $0 running total does not say surplus',
    stage2Note);
  ok(/break-even/i.test(stage2Note),
    'stage 2 note names break-even when the running total is exactly $0',
    stage2Note);
  ok(!/surplus/i.test(stage3Note),
    'stage 3 note for a $0 running total does not say surplus',
    stage3Note);
  ok(/break-even/i.test(stage3Note),
    'stage 3 note names break-even when the running total is exactly $0',
    stage3Note);
}

function wfBlock(html, key) {
  return (html.split(`data-planning-road-wf="${key}"`)[1] || '')
    .split('data-planning-road-wf="')[0];
}

console.log('\n=== 11. Waterfall contract — inline planned spend, no card strip, Forecast-only labels ===');
{
  const liveRoad = page.render(live, periods)['planning-road-ahead'].innerHTML;
  const incomeBlock = wfBlock(liveRoad, 'income');
  const liveTraj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  const liveMonth = (liveTraj.months || []).find(m => m && m.income
    && (m.income.status === 'calculated' || m.income.status === 'estimated'));
  const liveIncomeLines = liveMonth && Array.isArray(liveMonth.income.lines)
    ? liveMonth.income.lines : [];
  if (liveIncomeLines.length) {
    ok(liveIncomeLines.every(row => row && incomeBlock.includes(row.label)),
      'Planning reprints Forecast-published calendar income line labels and does not invent splits');
    ok(/Total income/.test(incomeBlock),
      'Planning reprints the Forecast income total beside published lines');
  } else {
    ok(!/\bDale\b/.test(incomeBlock) && !/\bAmanda\b/.test(incomeBlock),
      'income section does not invent salary names when Forecast published no income lines');
  }
  ok(!/<details/.test(incomeBlock) && !/planning-road-wf-chevron/.test(incomeBlock),
    'Income is not behind an expander; published lines stay always visible');
  ok(!/atlas-card|card-strip|Card badge|data-card-badge|purple Card/i.test(liveRoad),
    'Road Ahead markup has no Budget card-strip markers');

  const payPeriod = (liveTraj.payPeriods || []).find(p => p && p.stage1 && p.stage1.bills);
  const payRoad = payPeriod
    ? page.composeRoadTraj(liveTraj, 'pay-period', payPeriod.payday || payPeriod.id, live.meta.asOf)
    : { stages: '' };
  const billsLive = wfBlock(payRoad.stages, 'bills');
  const householdLive = wfBlock(payRoad.stages, 'household-budget');
  ok(/data-planning-road-wf-expand="bills"/.test(billsLive)
    && /planning-road-wf-chevron/.test(billsLive)
    && /data-planning-road-wf-row="bills-total"/.test(billsLive),
    'live Bills total stays visible in the collapsed expander summary');
  ok(/data-planning-road-wf-expand="household-budget"/.test(householdLive)
    && /planning-road-wf-chevron/.test(householdLive)
    && /data-planning-road-wf-row="household-budget-total"/.test(householdLive),
    'live Household budget total stays visible in the collapsed expander summary');
  const liveBillsLines = payPeriod && payPeriod.stage1 && payPeriod.stage1.bills
    && Array.isArray(payPeriod.stage1.bills.lines) ? payPeriod.stage1.bills.lines : [];
  const liveBudgetLines = payPeriod && payPeriod.stage1 && payPeriod.stage1.householdBudget
    && Array.isArray(payPeriod.stage1.householdBudget.lines)
    ? payPeriod.stage1.householdBudget.lines : [];
  if (liveBillsLines.length) {
    ok(liveBillsLines.every(row => row && billsLive.includes(row.label)),
      'Planning reprints Forecast-published stage1 bills line labels and does not invent splits');
    ok(!/data-planning-road-wf-lines="unavailable"/.test(billsLive)
      && !/Forecast has not published these line items/.test(billsLive),
      'Bills expander lists published lines instead of the fail-closed empty state');
  } else {
    ok(/data-planning-road-wf-lines="unavailable"/.test(billsLive)
      && /Forecast has not published these line items/.test(billsLive)
      && !/Mortgage/.test(billsLive) && !/Car payment/.test(billsLive),
      'Bills expander fail-closes when Forecast published no bill lines');
  }
  if (liveBudgetLines.length) {
    ok(liveBudgetLines.every(row => row && householdLive.includes(row.label)),
      'Planning reprints Forecast-published householdBudget line labels and does not invent splits');
    ok(!/data-planning-road-wf-lines="unavailable"/.test(householdLive)
      && !/Forecast has not published these line items/.test(householdLive),
      'Household budget expander lists published lines instead of the fail-closed empty state');
  } else {
    ok(/data-planning-road-wf-lines="unavailable"/.test(householdLive)
      && /Forecast has not published these line items/.test(householdLive),
      'Household budget expander fail-closes when Forecast published no budget lines');
  }
  ok(!/<details/.test(wfBlock(liveRoad, 'planned-spending')),
    'planned spending stays listed inline, not behind an expander');

  const traj = liveTraj;
  const withheld = JSON.parse(JSON.stringify(traj));
  const target = withheld.months[withheld.months.length - 1];
  target.stage3.result = { status: 'unavailable', reason: 'Forecast withheld this result.' };
  target.stage3.dateOrderResult = { status: 'unavailable', reason: 'Forecast withheld this result.' };
  const withheldRoad = page.composeRoadTraj(withheld, 'month', traj.months[0].month, live.meta.asOf);
  const chip = new RegExp(`data-road-timeline-period="${target.month}"[\\s\\S]*?planning-road-horizon-chip-dot-withheld`);
  ok(chip.test(withheldRoad.timeline),
    'a withheld month keeps a fail-closed horizon dot rather than a surplus or short colour');
  ok(!/data-road-horizon-stat="surplus"|months with a projected surplus/.test(withheldRoad.timeline + withheldRoad.horizonCounts),
    'horizon does not tally surplus/gap counts from chip signs');

  const withLines = JSON.parse(JSON.stringify(traj));
  const lined = withLines.months[0];
  lined.income = {
    amount: lined.income.amount,
    status: lined.income.status,
    identity: 'calendar-dated-income',
    lines: [
      { label: 'Published stream A', amount: 100, status: 'confirmed' },
      { label: 'Published stream B', amount: 50, status: 'estimated' },
    ],
  };
  const linedRoad = page.composeRoadTraj(withLines, 'month', lined.month, live.meta.asOf);
  const linedIncome = wfBlock(linedRoad.stages, 'income');
  ok(/Published stream A/.test(linedIncome)
    && /Published stream B/.test(linedIncome)
    && /planning-road-trust-confirmed">Confirmed</.test(linedIncome)
    && /Total income/.test(linedIncome)
    && !/<details/.test(linedIncome),
    'when Forecast publishes income line labels, those lines and the income total stay always visible');
  ok(!/\bDale\b/.test(linedIncome) && !/\bAmanda\b/.test(linedIncome)
    && !/Seaspan/.test(linedIncome) && !/Tennis/.test(linedIncome)
    && !/50\s*\/\s*50/.test(linedIncome),
    'reprinting published income lines does not invent Dale/Amanda, Seaspan/Tennis, or a 50/50 split');

  lined.stage2.commitments = {
    amount: 400,
    status: 'estimated',
    lines: [
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
    ],
  };
  const linedCommit = page.composeRoadTraj(withLines, 'month', lined.month, live.meta.asOf);
  const linedPlanned = wfBlock(linedCommit.stages, 'planned-spending');
  ok(/Published commitment A/.test(linedPlanned)
    && /Published commitment B/.test(linedPlanned)
    && linedPlanned.includes(longDate('2026-12-09'))
    && linedPlanned.includes(longDate('2026-12-25'))
    && !/<details/.test(linedPlanned)
    && /planning-road-wf-kicker[\s\S]*Planned spending/.test(linedPlanned)
    && !/planning-road-wf-label">Planned spending</.test(linedPlanned)
    && !/data-planning-road-wf-row="planned-spending-total"/.test(linedPlanned)
    && linedPlanned.includes(money2(250))
    && linedPlanned.includes(money2(150))
    && !linedPlanned.includes(money2(400))
    && /data-planning-road-wf-lines="named"/.test(linedPlanned),
    'waterfall reprints named Stage2 lines inline and omits a same-label Planned spending total');
  ok(/Published commitment A/.test(linedCommit.breakdown)
    && /Published commitment B/.test(linedCommit.breakdown)
    && /Dated commitments/.test(linedCommit.breakdown)
    && linedCommit.breakdown.includes(money2(400)),
    'breakdown sheet reprints mock Stage2 commitment labels beside the Dated commitments total');

  const noLines = JSON.parse(JSON.stringify(traj));
  noLines.months[0].stage2.commitments = {
    amount: 400,
    status: 'estimated',
  };
  const totalOnly = page.composeRoadTraj(noLines, 'month', noLines.months[0].month, live.meta.asOf);
  const totalOnlyPlanned = wfBlock(totalOnly.stages, 'planned-spending');
  ok(!/Published commitment A/.test(totalOnlyPlanned)
    && !/Published commitment A/.test(totalOnly.breakdown)
    && /Dated commitments/.test(totalOnly.breakdown)
    && /data-planning-road-wf-row="planned-spending-total"/.test(totalOnlyPlanned)
    && /planning-road-wf-label">Planned spending</.test(totalOnlyPlanned)
    && totalOnlyPlanned.includes('−' + money2(400))
    && /data-planning-road-wf-lines="total-only"/.test(totalOnlyPlanned),
    'absent Stage2 commitment lines keep Planned spending / Dated commitments total-only');

  const smoke = JSON.parse(JSON.stringify(traj));
  const smokeMonth = smoke.months.find(m => m.month === '2026-09') || smoke.months[0];
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
  const smokePlanned = wfBlock(
    page.composeRoadTraj(smoke, 'month', smokeMonth.month, live.meta.asOf).stages,
    'planned-spending');
  ok(/Burrards team fees/.test(smokePlanned)
    && smokePlanned.includes(longDate('2026-09-15'))
    && smokePlanned.includes('−' + money2(700))
    && /planning-road-wf-kicker[\s\S]*Planned spending/.test(smokePlanned)
    && /data-planning-road-wf-lines="named"/.test(smokePlanned)
    && !/planning-road-wf-label">Planned spending</.test(smokePlanned)
    && !/data-planning-road-wf-row="planned-spending-total"/.test(smokePlanned),
    'live-smoke pattern: named Burrards line is a wf row; same-label Planned spending total is not');

  const janEmpty = JSON.parse(JSON.stringify(traj));
  const janMonth = janEmpty.months.find(m => m.month === '2027-01') || janEmpty.months[0];
  janMonth.stage2 = janMonth.stage2 || {};
  janMonth.stage2.commitments = { amount: 0, status: 'calculated', lines: [] };
  const janPlanned = wfBlock(
    page.composeRoadTraj(janEmpty, 'month', janMonth.month, live.meta.asOf).stages,
    'planned-spending');
  ok(/planning-road-wf-label">Planned spending</.test(janPlanned)
    && /data-planning-road-wf-row="planned-spending-total"/.test(janPlanned)
    && /data-planning-road-wf-lines="total-only"/.test(janPlanned)
    && janPlanned.includes(money2(0))
    && !/Burrards team fees/.test(janPlanned),
    'empty-lines January-style month keeps the Planned spending $0 aggregate');
}

console.log('\n=== 12. Uniform headers, expanders with published lines, Dale/Amanda reprint ===');
{
  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  const withDetail = JSON.parse(JSON.stringify(traj));
  const period = withDetail.payPeriods[0];
  const incomeTotal = period.stage1.income.amount;
  const billsTotal = period.stage1.bills.amount;
  const householdTotal = period.stage1.householdBudget.amount;
  period.stage1.income = {
    amount: incomeTotal,
    status: period.stage1.income.status,
    lines: [
      { label: 'Dale', amount: 6240, status: 'confirmed' },
      { label: 'Amanda', amount: 4180, status: 'confirmed' },
    ],
  };
  period.stage1.bills = {
    amount: billsTotal,
    status: period.stage1.bills.status,
    lines: [
      { label: 'Mortgage', amount: 2140, status: 'confirmed' },
      { label: 'Car payment', amount: 600, status: 'confirmed' },
    ],
  };
  period.stage1.householdBudget = {
    amount: householdTotal,
    status: period.stage1.householdBudget.status,
    items: [
      { label: 'Groceries', amount: 800, status: 'calculated' },
      { label: 'Fuel', amount: 220, status: 'calculated' },
    ],
  };
  const road = page.composeRoadTraj(withDetail, 'pay-period', period.payday || period.id, live.meta.asOf);
  const income = wfBlock(road.stages, 'income');
  const bills = wfBlock(road.stages, 'bills');
  const household = wfBlock(road.stages, 'household-budget');
  const planned = wfBlock(road.stages, 'planned-spending');

  ok(/planning-road-wf-kicker/.test(income)
    && /planning-road-wf-kicker/.test(bills)
    && /planning-road-wf-kicker/.test(wfBlock(road.stages, 'obligations'))
    && /planning-road-wf-kicker/.test(household)
    && /planning-road-wf-kicker/.test(planned),
    'Income, Bills, Required debt, Household budget, and Planned spending all have section kickers');

  ok(/\bDale\b/.test(income) && /\bAmanda\b/.test(income)
    && income.includes(page.ctx.planningRoadSignedMoney(6240))
    && income.includes(page.ctx.planningRoadSignedMoney(4180))
    && /Income total/.test(income)
    && !/<details/.test(income),
    'published Dale and Amanda salary lines reprint always-visible under Income, plus the income total');

  ok(/<details class="planning-road-wf-expand" data-planning-road-wf-expand="bills"/.test(bills)
    && /planning-road-wf-chevron/.test(bills)
    && /data-planning-road-wf-row="bills-total"/.test(bills)
    && /Mortgage/.test(bills) && /Car payment/.test(bills)
    && bills.includes('−' + money2(2140)) && bills.includes('−' + money2(600))
    && !/ open/.test(bills.match(/<details[^>]*>/)[0]),
    'Bills expander lists Forecast-published lines, keeps the total in the collapsed summary, and starts closed');
  ok(/<details class="planning-road-wf-expand" data-planning-road-wf-expand="household-budget"/.test(household)
    && /planning-road-wf-chevron/.test(household)
    && /data-planning-road-wf-row="household-budget-total"/.test(household)
    && /Groceries/.test(household) && /Fuel/.test(household)
    && household.includes('−' + money2(800)),
    'Household budget expander lists Forecast-published items and keeps the total visible when collapsed');
  ok(!/data-planning-road-wf-lines="unavailable"/.test(bills)
    && !/data-planning-road-wf-lines="unavailable"/.test(household),
    'published detail lines replace the fail-closed expander empty state');
  ok(!/<details/.test(planned),
    'planned spending remains an inline list when peer sections expand');
  ok(!/atlas-card|card-strip|Card badge|purple Card/i.test(road.stages),
    'detailed waterfall reprint still has no credit-card strip');
}

console.log('\n=== 13. Road Ahead waterfall marks Estimated, leaves Calculated unmarked, and keeps full labels ===');
{
  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods, extraFacilities: live.revolvingExtra,
  });
  const withDetail = JSON.parse(JSON.stringify(traj));
  const period = withDetail.payPeriods[0];
  period.stage1.bills = {
    amount: period.stage1.bills.amount,
    status: 'estimated',
    lines: [{ label: 'Published bill', amount: 100, status: 'estimated' }],
  };
  period.stage1.obligations = {
    amount: period.stage1.obligations && period.stage1.obligations.amount != null
      ? period.stage1.obligations.amount : 200,
    status: 'estimated',
    lines: [{ label: 'Published debt', amount: 200, status: 'calculated' }],
  };
  period.stage1.householdBudget = {
    amount: period.stage1.householdBudget.amount,
    status: 'calculated',
    items: [{ label: 'Groceries', amount: 800, status: 'calculated' }],
  };
  period.stage1.result = {
    amount: period.stage1.result.amount,
    status: 'estimated',
  };
  period.stage2.commitments = {
    amount: period.stage2.commitments.amount,
    status: 'estimated',
  };
  period.stage3.result = {
    amount: period.stage3.result.amount,
    status: 'calculated',
  };
  const road = page.composeRoadTraj(withDetail, 'pay-period', period.payday || period.id, live.meta.asOf);
  const wf = road.stages;
  const bills = wfBlock(wf, 'bills');
  const obligations = wfBlock(wf, 'obligations');
  const household = wfBlock(wf, 'household-budget');
  const planned = wfBlock(wf, 'planned-spending');
  const after = wfBlock(wf, 'after-obligations');
  const finalRow = wfBlock(wf, 'final');

  ok(/Required debt payments/.test(obligations)
    && /Surplus after normal obligations|Shortfall after normal obligations|Break-even after normal obligations|After normal obligations/.test(wf)
    && /Household budget/.test(household)
    && /Planned spending/.test(planned)
    && /Bills/.test(bills),
    'waterfall keeps Forecast-published section labels; it does not invent shorter names');
  const calculatedChrome = /planning-road-trust-calculated|planning-road-wf-about|>Calculated</;
  const estimatedChip = /planning-road-trust-estimated[^>]*>Estimated</;
  const estimatedCount = html => (html.match(/planning-road-trust-estimated[^>]*>Estimated</g) || []).length;
  ok(!calculatedChrome.test(wf), 'no Calculated chip or about prefix anywhere on the waterfall');
  ok(bills.includes('−' + money2(100)) && estimatedCount(bills) === 2,
    'estimated Bills line and estimated Bills total each carry Estimated');
  ok(obligations.includes('−' + money2(200)) && estimatedCount(obligations) === 1,
    'Required debt payments: the estimated total is marked; the calculated line is not');
  ok(household.includes('−' + money2(800)) && estimatedCount(household) === 0,
    'calculated Household budget rows/totals stay unmarked');
  ok(estimatedChip.test(planned), 'estimated Planned spending carries Estimated');
  ok(estimatedChip.test(after), 'the estimated surplus-after row carries Estimated');
  ok(!estimatedChip.test(finalRow), 'the calculated final result row stays unmarked');
  ok(estimatedChip.test(road.lead) && !calculatedChrome.test(road.lead),
    'the hero marks its estimated figures Estimated and leaves calculated unmarked');
  ok(/planning-road-wf-label">Required debt payments</.test(obligations)
    && /planning-road-wf-result-label">/.test(after || wf),
    'long Forecast labels stay in the label slot, not abbreviated beside the amount');

  const liveRoad = page.render(live, periods)['planning-road-ahead'].innerHTML;
  const liveWf = (liveRoad.split('data-planning-road-waterfall="ready"')[1] || '')
    .split('planning-road-breakdown-band')[0];
  ok(!calculatedChrome.test(liveWf),
    'live Road Ahead waterfall render has no Calculated or about chrome');
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll planning road-ahead mobile presentation checks passed.');
