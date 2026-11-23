'use strict';
/*
 * v2 step 4, Neon REPORT 3 finding 5a (#1607 7110222917): the transaction
 * feed lags a fresh balance. The window ends today and every server gate
 * passes, but the newest spending transaction is days older than the
 * balance (bankFeedFreshness 'stale'). Figures built on that cohort must not
 * read as calculated: the current period's Household spend, Balance After
 * Deductions and Stack Surplus are estimated, through recommend, Stack and
 * the assistant packet. A fresh feed is the control. Invented values only.
 */
const Live = require('../scripts/live-plan');
const F = require('../public/forecast');
const A = require('../scripts/assistant-packet');
const base = require('./fixtures/card-backfill-data');
let failures = 0;
const ok = (c, m, d) => { console.log((c ? 'ok   ' : 'FAIL ') + m + (c || d === undefined ? '' : ' :: ' + JSON.stringify(d))); if (!c) failures++; };
const TODAY = '2026-09-20';

function refresh(txDate) {
  const x = base('card-x', 'card-x-min');
  x.data.meta.asOf = x.data.plan.opening.asOf = TODAY;
  x.data.plan.startingCash.breakdown[0].value = 100; x.data.plan.startingCash.breakdown[1].value = 500;
  x.data.plan.obligations = []; x.data.plan.budget.categories = []; x.data.plan.income[0].amount = 0; x.data.debts = [];
  x.accountMap.mappings = x.accountMap.mappings.slice(0, 3); x.payload.accounts = x.payload.accounts.slice(0, 3);
  const pidA = Number(x.accountMap.mappings[0].providerAccountId);
  for (const [i, v] of [[0, 600], [1, 0], [2, 0]]) { x.payload.accounts[i].balance = v; x.payload.accounts[i].balance_last_update = TODAY + 'T17:00:00Z'; }
  x.payload.transactions = [{ id: 901, account_id: pidA, date: txDate, amount: '25.00', currency: 'cad', is_pending: false, payee: 'Invented Shop' }];
  x.payload.categories = []; x.payload.tags = []; x.payload.fetchedAt = TODAY + 'T18:00:00Z';
  x.payload.transactionWindow = { startDate: '2026-09-01', endDate: TODAY, complete: true, hasMore: false, truncated: false };
  x.payload.pendingCoverage = { complete: true, hasMore: false, truncated: false, basis: 'is_pending-unbounded' };
  return Live.fromObservation(x);
}
const advise = res => F.recommend(res.data.plan, TODAY, { ...res.data.plan.defaults, debts: [],
  currentPeriodActuals: res.data.liveOverlay.currentPeriodActuals });
const current = advice => advice.payPeriodViews.find(v => v.timelineRole === 'current');

for (const [label, txDate, feed, want] of [['stale feed (newest spending 3 days old)', '2026-09-17', 'stale', 'estimated'],
  ['control: fresh feed (spending today)', TODAY, 'fresh', 'calculated']]) {
  console.log('\n=== ' + label + ' ===');
  const res = refresh(txDate);
  ok(res.data.liveOverlay.applied === true && res.report.observationReceipt.readyForReconciliation === true,
    'every server gate passes (the overlay applies)');
  ok(F.bankFeedFreshness(res.data.liveOverlay.currentPeriodActuals).status === feed, `bankFeedFreshness reads ${feed}`);
  const advice = advise(res), view = current(advice);
  ok(view.balanceAfterDeductions === (feed === 'stale' ? 0 : -25), 'Balance After Deductions is still published, never withheld here', view.balanceAfterDeductions);
  ok((view.balanceAfterDeductionsTrust || 'calculated') === want, `Balance After Deductions trust is ${want}`, view.balanceAfterDeductionsTrust);
  ok(view.stackSummary.surplus.trust === want, `Stack Surplus trust is ${want}`, view.stackSummary.surplus.trust);
  ok(feed === 'stale' ? !!(view.bankFeedEstimate && /bank transaction feed is behind/.test(view.bankFeedEstimate.reason))
    : view.bankFeedEstimate === undefined, feed === 'stale' ? 'the estimate carries its reason' : 'no estimate mark on a fresh feed');
  const later = advice.payPeriodViews.filter(v => v.timelineRole === 'next' || v.timelineRole === 'future');
  ok(later.every(v => v.balanceAfterDeductionsTrust === 'unavailable' || (v.balanceAfterDeductionsTrust || 'calculated') === (want === 'estimated' ? 'estimated' : (v.balanceAfterDeductionsTrust || 'calculated'))),
    'later periods opened from it are never more certain than the current period');
  const packet = A.buildPacket({ data: res.data, periods: { periods: {} }, questionsMarkdown: '', env: {}, now: TODAY + 'T19:00:00Z' });
  const totals = packet.forecast && packet.forecast.payPeriodTotals;
  const cur = totals && totals.periods && totals.periods.find(p => p.offset === 0);
  // The packet caps its pay-period totals at estimated already; its headline
  // Balance After Deductions carries Forecast's own trust, so it is the proof.
  const headline = packet.forecast && packet.forecast.predictedEndingBalance;
  ok(headline && headline.status === 'ok' && headline.trust === want, `packet: headline Balance After Deductions is ${want}`, headline);
  ok(cur && cur.stackSurplus.status === 'ok' && cur.stackSurplus.trust === 'estimated', 'packet: current Stack Surplus is never more than estimated', cur && cur.stackSurplus);
}
console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
