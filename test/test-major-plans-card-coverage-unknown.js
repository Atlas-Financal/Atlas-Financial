'use strict';
/* Future-cost verdicts withhold when card purchase coverage is unknown.
 *
 * Invented case. The cash a later card payment needs is unknown when the card
 * purchase coverage is unknown (here: a purchase in a foreign currency, which
 * the coverage reconciliation cannot price). Every verdict tests the day's cash
 * against a floor that includes that held cash, so with the held cash unknown
 * no verdict, margin or remaining amount can be stated: ON TRACK and FUNDING
 * GAP are both claims. The oracle is that rule, not the engine: with coverage
 * unknown every row is withheld; with coverage known the same rows keep the
 * hand-computed verdicts (see test-goal-cash-floor.js for the arithmetic).
 *
 * `node test/test-major-plans-card-coverage-unknown.js`
 */
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const A = require('../scripts/assistant-packet');
const fixture = require('./fixtures/card-purchase-coverage-data');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

// opening 500 + opening-cash 'extra'; buffer 100; purchase 300; one dated cost 200.
function world(extra, unknown) {
  const x = fixture();
  x.payload.transactions[0].amount = 300;
  x.payload.accounts[3].balance = 400 + 300;
  x.payload.accounts[0].balance = 500 + extra;
  if (unknown) x.payload.transactions[0].currency = 'usd';
  x.data.plan.defaults.targetBuffer = 100;
  x.data.plan.obligations = [];
  x.data.plan.income = [];
  x.data.plan.commitments = [{ id: 'plan-a', label: 'Invented plan', date: '2026-09-21',
    amount: 200, confidence: 'confirmed' }];
  const r = Live.fromObservation(x);
  const opts = { debts: r.data.debts, currentPeriodActuals: r.data.liveOverlay.currentPeriodActuals };
  return { x, data: r.data, opts };
}
const withheld = row => row && row.verdict === null && row.funded === null && row.margin === null
  && row.remaining === null && row.fundingMargin === null && row.deferred === null
  && row.fundingStatus === 'unavailable';

for (const [name, extra] of [['short of the floor', 0], ['well above the floor', 5000]]) {
  console.log(`=== ${name} ===`);
  const known = world(extra, false);
  const unknown = world(extra, true);
  ok(F.simulate(known.data.plan, known.x.asOf, known.opts).cardPurchaseCoverage.status === 'ready',
    'control: coverage is known');
  ok(F.simulate(unknown.data.plan, unknown.x.asOf, unknown.opts).cardPurchaseCoverage.status === 'unavailable',
    'coverage is unknown in the test world');

  const control = F.majorPlans(known.data.plan, known.x.asOf, known.opts).find(p => p.id === 'plan-a');
  ok(control && control.verdict === (extra ? 'ON TRACK' : 'FUNDING GAP') && control.fundingStatus == null,
    'control: known coverage keeps its verdict', control && control.verdict);

  const direct = F.majorPlans(unknown.data.plan, unknown.x.asOf, unknown.opts);
  ok(direct.length === 1 && direct.every(withheld), 'Forecast.majorPlans withholds every verdict',
    JSON.stringify(direct.map(r => [r.verdict, r.margin, r.fundingStatus])));
  const coverageReason = F.simulate(unknown.data.plan, unknown.x.asOf, unknown.opts).cardPurchaseCoverage.reason;
  ok(typeof coverageReason === 'string' && coverageReason.length > 0 && direct.every(r => r.fundingReason === coverageReason),
    'each withheld verdict names the card-coverage reason', JSON.stringify(direct.map(r => r.fundingReason)));
  ok(direct[0].need === control.need && direct[0].amountMin === control.amountMin,
    'the cost itself (need and amount) stays published');

  const advice = F.recommend(unknown.data.plan, unknown.x.asOf, Object.assign({}, unknown.opts, unknown.data.liveOverlay));
  ok(advice.cardCoverageUnavailable === true, 'recommend reports card coverage unavailable');
  ok(Array.isArray(advice.majorPlans) && advice.majorPlans.length === 1 && advice.majorPlans.every(withheld),
    'recommend publishes no verdict', JSON.stringify((advice.majorPlans || []).map(r => [r.verdict, r.verdictTrust])));
  ok((advice.majorPlans || []).every(r => r.fundingReason === coverageReason),
    'recommend carries the same named reason on every withheld row');
  ok((advice.majorPlans || []).every(r => r.verdictTrust !== 'estimated'),
    'a withheld verdict is never labelled an estimate');

  const packet = A.buildPacket({ data: unknown.data, periods: null, questionsMarkdown: '',
    now: '2026-09-20T18:00:00Z', env: {} });
  const blocks = [packet.forecast, packet.forecast.majorPlanFunding, packet.forecast.upcomingModeledCommitments].filter(Boolean);
  const items = blocks.flatMap(b => b.items || []);
  ok(blocks.some(b => b.status === 'unavailable') || (items.length > 0 && items.every(r => r.verdict == null)),
    'the assistant packet is not told a verdict', JSON.stringify(items.map(r => r.verdict)));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
