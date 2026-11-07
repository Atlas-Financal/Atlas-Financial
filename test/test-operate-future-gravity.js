'use strict';
/* AF-OPERATE-05 — the decision-first surface publishes incumbent
 * Forecast.majorPlans verdicts and Forecast.paydayAllocation set-asides.
 * Synthetic cents and timings are deliberately unlike live household facts.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

function loadRenderer() {
  const appSrc = read('public/app.js');
  const planSrc = read('public/plan.js');
  const grab = (src, re, label) => {
    const match = re.exec(src);
    if (!match) throw new Error('missing ' + label);
    return match[0];
  };
  const source = [
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
    grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    grab(planSrc, /^const FUTURE_PLAN_VERDICT = \{[\s\S]*?^\};$/m, 'FUTURE_PLAN_VERDICT'),
    grab(planSrc, /^const FUTURE_PLAN_FLEXIBILITY = \{[\s\S]*?^\};$/m, 'FUTURE_PLAN_FLEXIBILITY'),
    grab(planSrc, /^function futureCostNeedsAttention\([\s\S]*?\n\}$/m, 'futureCostNeedsAttention'),
    grab(planSrc, /^function futurePlanRemainingLabel\([\s\S]*?\n\}$/m, 'futurePlanRemainingLabel'),
    grab(planSrc, /^function futurePlanMeaning\([\s\S]*?\n\}$/m, 'futurePlanMeaning'),
    grab(planSrc, /^function futurePlanRequirement\([\s\S]*?\n\}$/m, 'futurePlanRequirement'),
    grab(planSrc, /^function futurePlanTiming\([\s\S]*?\n\}$/m, 'futurePlanTiming'),
    grab(planSrc, /^function futurePlanCardHtml\([\s\S]*?\n\}$/m, 'futurePlanCardHtml'),
    grab(planSrc, /^function futureGravityHtml\([\s\S]*?\n\}$/m, 'futureGravityHtml'),
  ].join('\n');
  return vm.runInNewContext(`${source}\n({ futureGravityHtml, money2 });`);
}

function card(html, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = html.search(new RegExp(`<div class="future-gravity-row [^"]*" data-future-gravity-id="${escaped}">`));
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < html.length; i++) {
    if (html.startsWith('<div', i)) depth++;
    else if (html.startsWith('</div>', i)) {
      depth--;
      if (depth === 0) return html.slice(start, i + 6);
    }
  }
  return '';
}

function shapingSlice(html) {
  const start = html.indexOf('Future costs shaping today');
  if (start < 0) return '';
  const residual = html.indexOf("does not constrain today's safe-to-spend");
  const note = html.indexOf('class="future-gravity-note"');
  const end = residual >= 0 ? residual : (note >= 0 ? note : html.length);
  return html.slice(start, end);
}

function residualSlice(html) {
  const start = html.indexOf("does not constrain today's safe-to-spend");
  if (start < 0) return '';
  const note = html.indexOf('class="future-gravity-note"', start);
  return html.slice(start, note >= 0 ? note : html.length);
}

function barePlan(extra) {
  return Object.assign({
    windowDays: 14,
    defaults: { targetBuffer: 500 },
    startingCash: { amount: 8000 },
    income: [], obligations: [], bills: [], commitments: [],
  }, extra || {});
}

function recOpts(extra) {
  return Object.assign({
    scenario: 'expected', incomeOverrides: {}, disabled: [],
    extraDebtMonthly: 0, targetBuffer: 500,
  }, extra || {});
}

const renderer = loadRenderer();

console.log('=== verdicts, remaining amounts and payday set-asides are direct outputs ===');
{
  const advice = {
    knowledge: { days: 487 },
    majorPlans: [
      { id: 'track', label: 'Estimated month cost', when: 'Nov 2026', date: null,
        need: 1234.56, amountMin: null, amountMax: null, remaining: 0,
        verdict: 'ON TRACK', confidence: 'estimated', flexibility: 'required' },
      { id: 'risk', label: 'Ranged flexible cost', when: 'Fall 2026', date: null,
        need: null, amountMin: 700, amountMax: 1200, remaining: 333.33,
        verdict: 'AT RISK', confidence: 'estimated', flexibility: 'bounded-flex' },
      { id: 'gap', label: 'Confirmed dated gap', when: null, date: '2027-03-15',
        need: 901.23, amountMin: null, amountMax: null, remaining: 444.44,
        verdict: 'FUNDING GAP', confidence: 'confirmed', flexibility: 'required' },
      { id: 'optional', label: 'Optional timing unknown', when: 'timing TBD', date: null,
        need: 222.22, amountMin: null, amountMax: null, remaining: 222.22,
        verdict: 'FUNDING GAP', confidence: 'estimated', flexibility: 'optional' },
    ],
    paydayAllocation: {
      futureCosts: [{ id: 'gap', allocated: 0 }],
      optional: [{ id: 'optional', allocated: 12.34 }],
      unresolved: [
        { id: 'track', reason: 'No exact date.' },
        { id: 'risk', reason: 'No exact date.' },
      ],
    },
  };
  const html = renderer.futureGravityHtml(advice);
  const track = card(html, 'track');
  const risk = card(html, 'risk');
  const gap = card(html, 'gap');
  const optional = card(html, 'optional');

  ok(track.includes('ON TRACK') && track.includes('$0.00') && track.includes('Covered in the plan'),
    'ON TRACK and its exact Forecast remaining amount stay together');
  ok(track.includes('No set-aside this payday. Still required. Forecast expects later cash to cover it.'),
    'ON TRACK with no payday contribution is explained in household language');
  ok(risk.includes('AT RISK') && risk.includes('$333.33') && risk.includes('At-risk amount'),
    'AT RISK remains distinct with the incumbent uncertainty amount');
  ok(gap.includes('FUNDING GAP') && gap.includes('$444.44') && gap.includes('Funding gap'),
    'FUNDING GAP remains distinct with the incumbent gap');
  ok(gap.includes('FUNDING GAP') && gap.includes('$444.44') && gap.includes('Funding gap')
    && !gap.includes('Covered in the plan') && !gap.includes('Set aside this payday'),
    'a zero payday allocation does not turn a funding gap into funded/on-track');
  ok(optional.includes('$12.34') && optional.includes('Set aside this payday')
    && optional.includes('OPTIONAL'),
  'an optional set-aside comes from Forecast.paydayAllocation without becoming required');
  const shaping = shapingSlice(html);
  const residual = residualSlice(html);
  ok(shaping.includes('data-future-gravity-id="track"') && shaping.includes('data-future-gravity-id="risk"')
    && shaping.includes('data-future-gravity-id="gap"')
    && !shaping.includes('data-future-gravity-id="optional"'),
    'required and bounded-flex rows stay in the shaping-today group');
  ok(residual.includes('data-future-gravity-id="optional"') && residual.includes('$12.34')
    && !residual.includes('Protected'),
    'an optional payday set-aside stays residual and is not labelled protected');
  ok(html.includes('Later bills across the 487-day plan')
    && html.includes('including costs beyond the next few months'),
    'the surface names the incumbent master horizon rather than the short view');
}

console.log('\n=== estimated, ranged, optional and unresolved trust stays intact ===');
{
  const advice = {
    majorPlans: [
      { id: 'month', label: 'Approximate month', when: 'Nov 2026', date: null,
        need: 1000, amountMin: null, amountMax: null, remaining: 0,
        verdict: 'ON TRACK', confidence: 'estimated', flexibility: 'required' },
      { id: 'range', label: 'Uncollapsed range', when: 'Fall 2026', date: null,
        need: null, amountMin: 700, amountMax: 1200, remaining: 150,
        verdict: 'AT RISK', confidence: 'estimated', flexibility: 'bounded-flex' },
      { id: 'undated', label: 'Undated optional', when: 'timing TBD', date: null,
        need: 400, amountMin: null, amountMax: null, remaining: 400,
        verdict: 'FUNDING GAP', confidence: 'estimated', flexibility: 'optional' },
    ],
    paydayAllocation: { futureCosts: [], unresolved: [{ id: 'month' }, { id: 'range' }] },
  };
  const html = renderer.futureGravityHtml(advice);
  ok(html.includes('Nov 2026') && !/Nov(?:ember)?\s+(?:1|30),?\s+2026/.test(html),
    'Nov 2026 remains approximate and acquires no invented day');
  ok(html.includes('Fall 2026') && html.includes('$700.00–$1,200.00') && !html.includes('$950.00'),
    'the ranged amount stays a range and acquires no midpoint');
  ok((html.match(/ESTIMATED/g) || []).length === 3,
    'estimated trust is visible on every estimated row');
  ok(html.includes('timing TBD') && html.includes('OPTIONAL'),
    'undated optional timing stays unresolved and is not promoted to required');
  ok((html.match(/EXACT DATE UNRESOLVED/g) || []).length === 2,
    'required/flexible approximate timing keeps the incumbent unresolved-date state');
}

console.log('\n=== a protected cost outside the short view remains visible and binds today ===');
{
  const asOf = '2026-08-19';
  const due = '2027-01-15';
  const start = 8000;
  const buffer = 500;
  const cost = 2000;
  const base = barePlan({ startingCash: { amount: start }, defaults: { targetBuffer: buffer } });
  const withFuture = barePlan({
    startingCash: { amount: start }, defaults: { targetBuffer: buffer },
    commitments: [{ id: 'long-horizon', label: 'Long-horizon protected cost',
      date: due, amount: cost, confidence: 'confirmed' }],
  });
  const without = F.recommend(base, asOf, recOpts({ targetBuffer: buffer, viewDays: 14 }));
  const advice = F.recommend(withFuture, asOf, recOpts({ targetBuffer: buffer, viewDays: 14 }));
  const days = F.knowledgeHorizon(withFuture, asOf, {}).days;
  const hand = Math.floor((((start - cost - buffer) * 7 / days) / 5)) * 5;
  const row = (advice.majorPlans || []).find(item => item.id === 'long-horizon');
  const html = renderer.futureGravityHtml(advice);

  ok(F.diffDays(asOf, due) >= 14,
    'fixture commitment is outside the 14-day display window', `${F.diffDays(asOf, due)} days away`);
  ok(advice.weekly === hand && advice.weekly < without.weekly,
    'independent cash drain proves the long-horizon cost constrains today',
    `$${advice.weekly} vs hand $${hand}; without $${without.weekly}`);
  ok(row && html.includes(row.label) && html.includes(row.verdict)
    && html.includes(renderer.money2(row.remaining)),
  'the same incumbent major-plan row remains visible on the operating surface');
}

console.log('\n=== a zero-allocated optional item is not presented as shaping or protecting today ===');
{
  const asOf = '2026-08-19';
  const due = '2027-01-15';
  const start = 8000;
  const buffer = 500;
  const cost = 2000;
  const requiredOnly = barePlan({
    startingCash: { amount: start }, defaults: { targetBuffer: buffer },
    commitments: [{ id: 'long-horizon', label: 'Long-horizon protected cost',
      date: due, amount: cost, confidence: 'confirmed' }],
  });
  const both = barePlan({
    startingCash: { amount: start }, defaults: { targetBuffer: buffer },
    commitments: [
      { id: 'long-horizon', label: 'Long-horizon protected cost',
        date: due, amount: cost, confidence: 'confirmed' },
      { id: 'optional-zero', label: 'Optional residual purchase',
        amount: 1500, optional: true, confidence: 'estimated' },
    ],
  });
  const withoutOptional = F.recommend(requiredOnly, asOf, recOpts({ targetBuffer: buffer, viewDays: 14 }));
  const advice = F.recommend(both, asOf, recOpts({ targetBuffer: buffer, viewDays: 14 }));
  const days = F.knowledgeHorizon(both, asOf, {}).days;
  const hand = Math.floor((((start - cost - buffer) * 7 / days) / 5)) * 5;
  const requiredRow = (advice.majorPlans || []).find(item => item.id === 'long-horizon');
  const optionalRow = (advice.majorPlans || []).find(item => item.id === 'optional-zero');

  const rendered = {
    knowledge: advice.knowledge,
    majorPlans: advice.majorPlans,
    paydayAllocation: {
      futureCosts: (advice.paydayAllocation && advice.paydayAllocation.futureCosts) || [],
      optional: [{ id: 'optional-zero', allocated: 0 }],
      unresolved: (advice.paydayAllocation && advice.paydayAllocation.unresolved) || [],
    },
  };
  const html = renderer.futureGravityHtml(rendered);
  const shaping = shapingSlice(html);
  const residual = residualSlice(html);
  const optionalCard = card(html, 'optional-zero');

  ok(F.diffDays(asOf, due) >= 14,
    'fixture commitment is outside the 14-day display window', `${F.diffDays(asOf, due)} days away`);
  ok(advice.weekly === hand && advice.weekly === withoutOptional.weekly,
    'independent cash drain proves only the required long-horizon cost constrains today',
    `$${advice.weekly} vs hand $${hand}; required-only $${withoutOptional.weekly}`);
  ok(requiredRow && shaping.includes(requiredRow.label) && shaping.includes(requiredRow.verdict)
    && shaping.includes(renderer.money2(requiredRow.remaining))
    && shaping.includes('data-future-gravity-id="long-horizon"'),
    'the required long-horizon commitment remains visible in the protected shaping-today group');
  ok(optionalRow && optionalRow.flexibility === 'optional',
    'Forecast still exposes the optional residual as optional, not required');
  ok(!shaping.includes('data-future-gravity-id="optional-zero"')
    && !shaping.includes('Optional residual purchase'),
    'a zero-allocated optional item is absent from the shaping-today / protected group');
  ok(residual.includes('data-future-gravity-id="optional-zero"')
    && residual.includes("does not constrain today's safe-to-spend")
    && optionalCard.includes('OPTIONAL')
    && !optionalCard.includes('Protected')
    && !optionalCard.includes('Set aside this payday'),
    'the zero optional set-aside stays in a separate residual section and is not labelled protected');
}

console.log('\n=== approximate timing travels through Forecast; the page stays a renderer ===');
{
  const plan = barePlan({
    commitments: [{ id: 'approx', label: 'Approximate commitment', amount: 321,
      when: 'late Sep 2026', confidence: 'estimated' }],
  });
  const advice = F.recommend(plan, '2026-08-19', recOpts());
  const row = (advice.majorPlans || []).find(item => item.id === 'approx');
  const html = renderer.futureGravityHtml(advice);
  ok(row && row.when === 'late Sep 2026' && html.includes('late Sep 2026'),
    'the page receives approximate timing from Forecast.majorPlans, not raw commitments');

  const planSrc = read('public/plan.js');
  const helper = /function futureGravityHtml\([\s\S]*?\n\}/m.exec(planSrc);
  ok(helper && !/plan\.commitments|Forecast\.[A-Za-z]+\s*\(|\.reduce\(|Math\./.test(helper[0]),
    'futureGravityHtml performs no future-cost arithmetic or Forecast decision');
  ok(/function futureGravityHtml/.test(planSrc)
    && !/See later bills and big purchases/.test(planSrc),
    'later-bills inventory formatter remains; it is not mounted on the default Plan');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
