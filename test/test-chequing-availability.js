'use strict';
/* Owner-requested chequing availability headline.
 *
 * Independent identities prove the headline uses current observed Chequing A
 * and Chequing B plus unused Chequing B overdraft. Savings, credit-card
 * capacity, HELOC capacity, and a stale Forecast opening never enter.
 * Overdraft never enters Forecast cash allocation.
 */
const fs = require('fs');
const path = require('path');
const data = require('../data.json');
const Forecast = require('../public/forecast.js');
const C = require('../public/forecast-chequing.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const close = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const roundCent = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const OWNER_A = 217.69;
const OWNER_B = -591;
const OWNER_SAVINGS = 0.58;
const OWNER_LIMIT = 600;
function openingValue(id) {
  const row = ((data.plan && data.plan.startingCash && data.plan.startingCash.breakdown) || [])
    .find(item => item && item.id === id);
  return Number(row && row.value);
}
const openingA = openingValue('chequing-a');
const openingB = openingValue('chequing-b');
const openingSavings = openingValue('savings');
const openingChequing = roundCent(openingA + openingB);
const openingHeadline = roundCent(Math.max(0, openingA) + Math.max(0, openingB) + OWNER_LIMIT);

function independentAvailable(a, b, limit, pending) {
  const used = Math.max(0, -Number(b));
  const unused = Math.max(0, Number(limit) - used - (Number(pending) || 0));
  const positive = Math.max(0, Number(a)) + Math.max(0, Number(b));
  return {
    net: roundCent(Number(a) + Number(b)),
    used: roundCent(used),
    unused: roundCent(unused),
    available: roundCent(Math.max(0, positive + unused)),
  };
}

console.log('=== dated opening without live observations ===');
{
  const summary = C.chequingAvailability(data.plan, data.revolvingExtra);
  ok(summary.status === 'available', 'dated-opening chequing capacity is available');
  ok(summary.cashSource === 'opening', 'without observedCash the helper reads the Forecast opening');
  ok(close(summary.chequingBalance, openingA + openingB),
    'actual chequing balance is Chequing A + Chequing B only',
    String(summary.chequingBalance));
  ok(close(summary.overdraftLimit, OWNER_LIMIT),
    'overdraft limit comes from the incumbent facility', String(summary.overdraftLimit));
  ok(close(summary.available, openingHeadline),
    'dated opening with unused full overdraft is Chequing A + B + unused limit',
    String(summary.available));
  ok(close(summary.overdraftRemaining, OWNER_LIMIT),
    'positive Chequing B leaves the full overdraft unused');
  ok(summary.accountBalances.length === 2
      && summary.accountBalances.some(row => row.id === 'chequing-a')
      && summary.accountBalances.some(row => row.id === 'chequing-b')
      && !summary.accountBalances.some(row => row.id === 'savings'),
    'savings is excluded from the household chequing headline');
  ok(!close(summary.available, openingA + openingB + openingSavings + OWNER_LIMIT),
    'the savings balance cannot leak into available-in-chequing');
}

console.log('\n=== owner-confirmed current chequing identity ===');
{
  const expected = independentAvailable(OWNER_A, OWNER_B, OWNER_LIMIT, 0);
  ok(close(expected.net, -373.31), 'independent net actual chequing is −$373.31');
  ok(close(expected.used, 591) && close(expected.unused, 9),
    'independent unused overdraft is $9 after $591 of a $600 limit is consumed');
  ok(close(expected.available, 226.69),
    'independent available in chequing is $217.69 usable + $9 unused overdraft');
  ok(!close(expected.available, OWNER_A + OWNER_LIMIT),
    'independent identity does not add the full $600 after $591 is already used');
  ok(!close(expected.available, openingHeadline),
    'independent identity is not the stale Forecast opening plus the full overdraft limit');

  const plan = {
    opening: { asOf: '2026-08-19' },
    startingCash: { breakdown: [
      { id: 'chequing-a', value: openingA },
      { id: 'chequing-b', value: openingB },
      { id: 'savings', value: OWNER_SAVINGS },
    ] },
  };
  const extra = [
    { id: 'overdraft', cash: 'chequing-b', limit: OWNER_LIMIT, pending: 0 },
    { id: 'heloc-room', limit: 202654 },
    { id: 'cards-room', limit: 20000 },
  ];
  const liveOverlay = {
    applied: false,
    observedCash: {
      complete: true,
      asOf: '2026-08-26',
      accounts: [
        { id: 'chequing-a', value: OWNER_A, evidenceDate: '2026-08-26' },
        { id: 'chequing-b', value: OWNER_B, evidenceDate: '2026-08-26' },
        { id: 'savings', value: OWNER_SAVINGS, evidenceDate: '2026-08-26' },
        { id: 'heloc', value: 202654, evidenceDate: '2026-08-26' },
        { id: 'tdcc', value: 2000, evidenceDate: '2026-08-26' },
      ],
    },
  };
  const summary = C.chequingAvailability(plan, extra, liveOverlay);
  ok(summary.status === 'available' && summary.cashSource === 'observed-cash',
    'fresh observed chequing wins over the dated Forecast opening');
  ok(close(summary.accountBalances.find(row => row.id === 'chequing-a').value, OWNER_A)
      && close(summary.accountBalances.find(row => row.id === 'chequing-b').value, OWNER_B),
    'observed Chequing A is +217.69 and Chequing B is −591.00');
  ok(close(summary.chequingBalance, expected.net),
    'actual chequing balance is the observed net, not the Aug 19 opening',
    String(summary.chequingBalance));
  ok(close(summary.overdraftUsed, expected.used)
      && close(summary.overdraftRemaining, expected.unused),
    'used overdraft is $591 and unused overdraft is $9, not $600');
  ok(close(summary.available, expected.available),
    'available in chequing is the independent $226.69 identity',
    String(summary.available));
  ok(!close(summary.available, openingHeadline),
    'stale opening plus the full overdraft limit cannot produce the headline when newer observations are authoritative');
  ok(!close(summary.available, OWNER_A + OWNER_LIMIT),
    'the full $600 overdraft is not added after $591 has already been consumed');
  ok(!close(summary.available, expected.net + OWNER_SAVINGS + expected.unused),
    'savings $0.58 is excluded from available-in-chequing');
  ok(!close(summary.available, expected.available + 202654)
      && !close(summary.available, expected.available + 20000),
    'HELOC and credit-card capacity do not enter available-in-chequing');
  ok(close(Forecast.startingCashAmount(plan), openingA + openingB),
    'Forecast cash-only opening is household chequing and is not forced equal to available-in-chequing',
    String(Forecast.startingCashAmount(plan)));
}

console.log('\n=== overdraft already used is not double-counted ===');
{
  const plan = {
    opening: { asOf: '2030-01-15' },
    startingCash: { breakdown: [
      { id: 'chequing-a', value: 1000 },
      { id: 'chequing-b', value: -200 },
      { id: 'savings', value: 9999 },
    ] },
  };
  const extra = [{ id: 'overdraft', cash: 'chequing-b', limit: 600, pending: 0 }];
  const expected = independentAvailable(1000, -200, 600, 0);
  const summary = C.chequingAvailability(plan, extra);
  ok(close(summary.chequingBalance, expected.net),
    'negative Chequing B is already reflected in the combined chequing balance');
  ok(close(summary.overdraftUsed, expected.used) && close(summary.overdraftRemaining, expected.unused),
    'used and remaining overdraft are separated correctly');
  ok(close(summary.available, expected.available),
    'capacity adds only unused overdraft to the positive chequing position');
}

console.log('\n=== missing authority fails closed ===');
{
  const noFacility = C.chequingAvailability(data.plan, []);
  ok(noFacility.status === 'unavailable' && noFacility.available == null,
    'missing overdraft facility does not invent a $600 limit');
  const noChecking = C.chequingAvailability({ startingCash: { breakdown: [] } }, data.revolvingExtra);
  ok(noChecking.status === 'unavailable' && noChecking.available == null,
    'missing chequing opening does not publish a capacity figure');
  const incomplete = C.chequingAvailability(data.plan, data.revolvingExtra, {
    observedCash: {
      complete: false,
      asOf: '2026-08-26',
      accounts: [{ id: 'chequing-a', value: OWNER_A, evidenceDate: '2026-08-26' }],
    },
  });
  ok(incomplete.cashSource === 'opening' && close(incomplete.available, openingHeadline),
    'incomplete observedCash does not displace the opening');
}

console.log('\n=== Forecast extension and load order ===');
{
  const engine = read('public/forecast-chequing.js');
  ok(/root\.Forecast\.chequingAvailability\s*=\s*api\.chequingAvailability/.test(engine),
    'derived figure is attached to Forecast authority');
  ok(!/\b600\b/.test(engine) && !/\b226\.69\b/.test(engine) && !/\b217\.69\b/.test(engine),
    'Forecast helper reads current balances and the overdraft limit from authority data instead of hardcoding them');
  const html = read('public/index.html');
  const forecastAt = html.indexOf('<script src="/forecast.js"></script>');
  const extensionAt = html.indexOf('<script src="/forecast-chequing.js"></script>');
  const planAt = html.indexOf('<script src="/plan.js"></script>');
  const waterfallAt = html.indexOf('<script src="/cash-waterfall.js"></script>');
  const headlineAt = html.indexOf('<script src="/chequing-headline.js"></script>');
  ok(forecastAt >= 0 && extensionAt > forecastAt && planAt > extensionAt,
    'chequing authority loads after Forecast and before Plan');
  ok(waterfallAt < 0 && headlineAt < 0,
    'Plan does not load the chequing-headline adapter that mixed overdraft into the cash number');
  ok(!fs.existsSync(path.join(__dirname, '..', 'public/chequing-headline.js')),
    'the retired chequing-headline adapter is removed, not merely unloaded (#822)');
  const architecture = read('ARCHITECTURE.md');
  ok(/Forecast\.chequingAvailability/.test(architecture)
      && /liveOverlay\.observedCash/.test(architecture),
    'ARCHITECTURE names the chequing-availability authority and the observed-cash boundary');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
