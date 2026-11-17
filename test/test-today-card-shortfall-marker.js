'use strict';

// Owner decision (Dale, 2026-11-17): when Forecast's paydayAllocation reports
// an obligations or essentials shortfall, the live Budget page flags it on the
// Today card's closed face, not only inside the closed evidence panel. Marker
// only: it prints no amount and computes nothing. Invented data throughout.
const assert = require('node:assert/strict');
const { loadBudgetPage } = require('./lib/budget-page-harness');

const page = loadBudgetPage();
const card = page.get('budgetTodayCashCardHtml');
let checks = 0;
const ok = (value, why) => { assert.ok(value, why); checks++; };
const eq = (a, b, why) => { assert.equal(a, b, why); checks++; };

const MARKER = /<p class="budget-cash-notice has-gap" data-shortfall-reported>Payday shortfall reported<\/p>/;
const markers = html => (html.match(/data-shortfall-reported/g) || []).length;
// The closed face is everything before the evidence panel opens.
const closedFace = html => html.slice(0, html.indexOf('data-budget-today-evidence'));

// A ready, trusted from-today funding row (invented), so the card prints its
// notices. notReady variants break exactly one readiness condition each.
function today(overrides) {
  return Object.assign({ basis: 'Budget-from-today', status: 'ready', trust: 'calculated', contribution: 0,
    currentCash: 600, operatingBills: 100, remainingHousehold: 100, requiredOperatingCash: 200,
    availableNow: 400, operatingShortfall: 0 }, overrides);
}
function ctx(allocation, funding = today()) {
  return { advice: { defaultView: { asOf: '2026-09-30' }, paydayAllocation: allocation,
    payPeriodViews: [{ id: 'current', timelineRole: 'current', start: '2026-09-25', end: '2026-10-08',
      fromTodayFunding: funding }] }, plan: {} };
}

// 1. A reported shortfall in either bucket shows exactly one marker, on the closed face.
for (const bucket of ['obligations', 'essentials']) {
  for (const amount of [0.01, 50, 1234.56]) {
    const input = ctx({ obligations: { shortfall: 0 }, essentials: { shortfall: 0 }, [bucket]: { shortfall: amount } });
    const before = JSON.stringify(input);
    const html = card(input);
    eq(markers(html), 1, bucket + ' shortfall ' + amount + ': exactly one marker');
    ok(MARKER.test(closedFace(html)), bucket + ' shortfall ' + amount + ': marker is on the closed face');
    ok(!/[\d$]/.test(html.match(/data-shortfall-reported>([^<]*)</)[1]),
      bucket + ' shortfall ' + amount + ': the marker prints no amount');
    eq(JSON.stringify(input), before, bucket + ': rendering does not mutate the Forecast output');
  }
}

// 2. Both buckets short still show one marker, not two.
eq(markers(card(ctx({ obligations: { shortfall: 10 }, essentials: { shortfall: 20 } }))), 1,
  'two short buckets show one marker');

// 3. No reported shortfall shows no marker: zero, negative, missing, non-number.
for (const allocation of [
  {}, { obligations: { shortfall: 0 }, essentials: { shortfall: 0 } },
  { obligations: { shortfall: -5 } }, { essentials: { shortfall: null } },
  { obligations: { shortfall: '50' } }, { essentials: {} }, { obligations: null },
]) {
  eq(markers(card(ctx(allocation))), 0, 'no marker for ' + JSON.stringify(allocation));
}
eq(markers(card({ advice: {}, plan: {} })), 0, 'no paydayAllocation: no marker');

// 4. A reported shortfall prints no marker when the card's own funding is not
// ready or not trusted (lead ruling on #1268: unknown reads unknown).
const short = { obligations: { shortfall: 50 }, essentials: { shortfall: 25 } };
eq(markers(card(ctx(short))), 1, 'control: the same shortfall on a ready card shows the marker');
for (const [why, funding] of [
  ['no from-today funding row', null],
  ['funding status unavailable', today({ status: 'unavailable' })],
  ['funding trust unknown', today({ trust: 'unknown' })],
  ['funding trust unavailable', today({ trust: 'unavailable' })],
  ['wrong funding basis', today({ basis: 'something-else' })],
  ['contribution not a number', today({ contribution: null })],
]) {
  eq(markers(card(ctx(short, funding))), 0, why + ': no marker even though a shortfall is reported');
}

console.log('PASS Today card flags a Forecast-reported payday shortfall on its closed face, marker only: ' + checks + ' checks');
