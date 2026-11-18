'use strict';
/* The Budget page shows later pay periods, estimated, while today's cash is
 * unconfirmed.
 *
 * Owner decision (Dale, #821 6964438984): when today's cash cannot be
 * confirmed, Forecast withholds only the current period and releases later
 * periods as estimates (#1295). The page keeps its "Current plan unavailable"
 * card for today and, beneath it, prints each released later period's income,
 * bills, Household budget and Balance After Deductions with the estimate tag.
 * It prints only Forecast's fields: nothing is promoted, nothing is totalled,
 * and no opening-dependent close is shown.
 *
 * Rendered through the live composition (BudgetSurface.html with
 * budgetSurfaceParts, as plan.js budgetSurfaceHtml calls it). Invented plan,
 * hand-derived figures (same plan as test-estimated-future-periods.js):
 *   2026-10-23..11-05: 3000 - 1200 - 200 = 1600
 *   2026-11-06..11-19: 3000 -    0 - 200 = 2800
 *   2026-11-20..12-03: 3000 - 1200 - 200 = 1600
 *   2026-12-04..12-17: 3000 -    0 - 200 = 2800
 *   2026-12-18..12-31: 3000 -    0 - 200 = 2800 (the next rent is Jan 1)
 *
 * `node test/test-budget-estimated-later-periods.js`
 */
const F = require('../public/forecast.js');
const BudgetSurface = require('../public/budget-surface.js');
const { loadBudgetPage } = require('./lib/budget-page-harness');

let failures = 0;
const ok = (cond, label, detail) => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ' — ' + detail : ''}`);
};

const AS_OF = '2026-10-09';
const plan = () => ({
  defaults: { targetBuffer: 500 }, windowDays: 91,
  startingCash: { breakdown: [{ id: 'chequing-a', label: 'Invented chequing', value: 2500, class: 'spendable' }] },
  opening: { asOf: AS_OF },
  nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
  income: [{ id: 'payroll', label: 'Invented payroll', frequency: 'biweekly', anchor: '2026-10-09', amount: 3000, confidence: 'confirmed' }],
  bills: [{ id: 'rent', label: 'Invented rent', amount: 1200, frequency: 'monthly', day: 1, confidence: 'confirmed', payingAccount: 'chequing-a' }],
  obligations: [], commitments: [],
  budget: { categories: [{ id: 'groceries', label: 'Invented groceries', plannedWeekly: 100 }] },
});
const UNCONFIRMED = { operatingPlan: 'unavailable', operatingPlanNote: 'Invented: the dated opening is stale.' };
const page = loadBudgetPage();
const render = extra => {
  const p = plan();
  const advice = F.recommend(p, AS_OF, Object.assign({ targetBuffer: 500, debts: [] }, extra || {}));
  const ctx = { advice, weekly: advice.weekly, recommended: advice.weekly, plan: p, asOf: AS_OF, debts: [], liveOverlay: null };
  return BudgetSurface.html(ctx, page.get('budgetSurfaceParts')());
};
const laterCard = html => {
  const m = /<section class="budget-surface-card budget-surface-later"[\s\S]*?<\/section>/.exec(html);
  return m ? m[0] : '';
};
const period = (card, start) => {
  const m = new RegExp(`<article class="estimated-later-period" data-estimated-later-period="${start}">[\\s\\S]*?</article>`).exec(card);
  return m ? m[0] : '';
};
const term = (block, key) => {
  const m = new RegExp(`data-estimated-term="${key}"><dt>[^<]*</dt><dd>([^<]*)( <span class="trust-tag trust-estimated">estimate</span>)?</dd>`).exec(block);
  return m ? { text: m[1], estimated: !!m[2] } : null;
};

console.log('=== today unconfirmed: the unavailable card stays, later periods show beneath it, estimated ===');
{
  const html = render(UNCONFIRMED);
  ok(/data-budget-surface="unavailable"/.test(html) && /Current plan unavailable/.test(html),
    'the Budget still says today\'s plan is unavailable');
  const card = laterCard(html);
  ok(!!card && /Later pay periods/.test(card), 'a Later pay periods card is shown');
  ok(/data-estimated-later-reason>estimate — /.test(card) && /Today&#39;s cash is not confirmed/.test(card),
    'it says why: today\'s cash is not confirmed, so these are estimates');
  const expected = [
    { start: '2026-10-23', range: 'Oct 23–Nov 5', income: '$3,000.00', bills: '$1,200.00', household: '$200.00', bad: '$1,600.00' },
    { start: '2026-11-06', range: 'Nov 6–Nov 19', income: '$3,000.00', bills: '$0.00', household: '$200.00', bad: '$2,800.00' },
    { start: '2026-11-20', range: 'Nov 20–Dec 3', income: '$3,000.00', bills: '$1,200.00', household: '$200.00', bad: '$1,600.00' },
    { start: '2026-12-04', range: 'Dec 4–Dec 17', income: '$3,000.00', bills: '$0.00', household: '$200.00', bad: '$2,800.00' },
    { start: '2026-12-18', range: 'Dec 18–Dec 31', income: '$3,000.00', bills: '$0.00', household: '$200.00', bad: '$2,800.00' },
  ];
  ok((card.match(/<article /g) || []).length === expected.length, 'exactly the five released later periods are listed');
  for (const e of expected) {
    const block = period(card, e.start);
    ok(!!block && block.includes(e.range), `${e.start}: the period is listed as ${e.range}`);
    const got = ['income', 'bills', 'household', 'balance-after-deductions'].map(k => term(block, k));
    ok(got.every(Boolean) && got[0].text === e.income && got[1].text === e.bills && got[2].text === e.household
      && got[3].text === e.bad, `${e.start}: income, bills, Household and Balance After Deductions are the hand-derived figures`,
      JSON.stringify(got.map(g => g && g.text)));
    ok(got.every(g => g && g.estimated), `${e.start}: every figure carries the estimate tag`);
  }
  ok(!period(card, '2026-10-09'), 'today\'s own period is not listed');
  ok(!/calculated|verified|confirmed/i.test(card.replace(/not confirmed/g, '')),
    'the card claims nothing calculated, verified or confirmed');
  const blocks = (card.match(/<article[\s\S]*?<\/article>/g) || []).join('');
  ok(blocks && !/Planned close|sweep|Opening|carried|Extra debt|Current Balance/i.test(blocks)
    && (blocks.match(/<dt>/g) || []).length === 5 * 4,
    'each period prints only its four terms: no opening-dependent close, sweep, carry or debt decision');
}

console.log('\n=== controls: healthy cash and an unresolved income occurrence show no estimate card ===');
{
  const healthy = render({});
  ok(!/data-budget-surface="unavailable"/.test(healthy) && !laterCard(healthy) && !/estimated-later/.test(healthy),
    'healthy cash: the normal Budget, no Later pay periods card');
  const income = render({ ...UNCONFIRMED, incomeReconciliation: { status: 'unavailable', asOf: AS_OF,
    reason: 'Invented: a scheduled receipt is unresolved.' } });
  ok(/data-budget-surface="unavailable"/.test(income) && !laterCard(income),
    'income unresolved: still unavailable, and no later period is shown (Forecast withholds them)');
}

console.log('\n=== a figure without an estimated trust word is never printed untagged ===');
{
  const p = plan();
  const advice = F.recommend(p, AS_OF, Object.assign({ targetBuffer: 500, debts: [] }, UNCONFIRMED));
  const first = advice.payPeriodViews.find(v => v && v.currentCashUnconfirmed);
  first.incomeTrust = 'calculated';        // a stronger word than Forecast publishes
  delete first.periodBillLoadTrust;        // no word at all
  first.budgetHoldTrust = 'verified';
  first.balanceAfterDeductionsTrust = 'unavailable';
  const ctx = { advice, weekly: advice.weekly, recommended: advice.weekly, plan: p, asOf: AS_OF, debts: [], liveOverlay: null };
  const block = period(laterCard(BudgetSurface.html(ctx, page.get('budgetSurfaceParts')())), first.start);
  const texts = ['income', 'bills', 'household', 'balance-after-deductions'].map(k => {
    const m = new RegExp(`data-estimated-term="${k}"><dt>[^<]*</dt><dd>([\\s\\S]*?)</dd>`).exec(block);
    return m ? m[1] : null;
  });
  ok(texts.every(t => t === 'Unavailable'),
    'calculated, missing, verified or unavailable trust prints Unavailable, never a bare or stronger figure', JSON.stringify(texts));
}

console.log('\n=== the page only prints Forecast fields ===');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'plan.js'), 'utf8');
  const fn = /function budgetEstimatedLaterPeriodsHtml\([\s\S]*?\n\}/.exec(src);
  ok(!!fn && /currentCashUnconfirmed/.test(fn[0]) && !/Forecast\.|reduce\(|\+ Number|- Number/.test(fn[0]),
    'the renderer selects released periods by Forecast\'s marker and does no arithmetic');
}

console.log('\n=== the assistant packet never prints a released figure more strongly ===');
{
  // The packet carries only the current period's Balance After Deductions,
  // which stays withheld; it publishes no later-period figure at all.
  const Assistant = require('../scripts/assistant-packet');
  const p = plan();
  p.startingCash.breakdown[0].value = null; // unknown chequing opening -> today's plan unavailable
  const packet = Assistant.buildPacket({ data: { meta: { asOf: AS_OF }, plan: p, debts: [], accounts: [], revolvingExtra: [] },
    periods: { periods: {} }, questionsMarkdown: '', env: {}, now: AS_OF + 'T19:00:00Z' });
  const text = JSON.stringify(packet);
  const bad = packet.forecast && packet.forecast.predictedEndingBalance;
  ok(!!bad && bad.status === 'unavailable', 'the packet\'s current Balance After Deductions stays unavailable', bad && bad.status);
  ok(!/"amount":(1600|2800)\b/.test(text) && !/currentCashUnconfirmed/.test(text),
    'no released later-period amount appears in the packet');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll Budget estimated-later-period checks passed.');
