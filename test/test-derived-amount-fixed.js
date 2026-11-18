'use strict';
/* Owner decision (#821, 2026-11-18): whether a plan bill's amount is fixed (`amountFixed`, #1320's D2 remainder rule)
 * comes from its Lunch Money payment history, never a hand mark. One separate bounded read (GET /v2/transactions over
 * 200 days) feeds only that flag. A bill is fixed when the latest min(6, count) of its identified posted CAD payments on
 * the rule's own account, with count >= 3, are all equal to the cent and equal to the plan amount, and the newest is no
 * older than two of the bill's intervals. Anything uncertain leaves it not fixed. Recomputed on every observation.
 *
 * Path: invented raw Lunch Money payload (with and without the history read) -> scripts/provider-observe.js ->
 * scripts/live-plan.js (acceptance harness) -> served plan -> Forecast.recommend. The fetch itself runs against a
 * loopback stand-in for the Lunch Money API.
 *
 * Invented world: the acceptance harness base world as of Wed 2026-10-14 and one invented $90 monthly hydro bill due
 * on the 12th, paid from chequing-a, identified by its payee. Every expected flag below is read off the rule by hand.
 *
 * `node test/test-derived-amount-fixed.js`
 */
const http = require('http');
const H = require('./acceptance/harness.js');
const O = require('../scripts/provider-observe');
const Live = require('../scripts/live-plan');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented hydro' };
const pay = (amount, date, extra = {}) => H.lm({ date, amount, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro', ...extra });
const monthly = (amounts, lastMonth = 9) => amounts.map((a, i) => pay(a, `2026-${String(lastMonth - amounts.length + 1 + i).padStart(2, '0')}-12`));

function serve({ bills = [HYDRO], history, transactions = [], identityRules } = {}) {
  const w = H.baseWorld();
  w.bills = bills;
  if (identityRules) w.identityRules = w.identityRules.concat(identityRules);
  w.transactions = transactions;
  if (history) w.amountHistory = history;
  H.productionOpening(w);
  const result = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)), payload: H.rawPayload(w),
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  if (result.error) throw result.error;
  return { w, result, plan: result.data.plan, report: result.report,
    fixed: id => (result.data.plan.bills.find(b => b.id === id) || {}).amountFixed === true };
}
const fixedFor = (txs, opts = {}) => serve({ ...opts, history: { transactions: txs, ...(opts.historyExtra || {}) } });

console.log('1. The rule');
{
  ok(fixedFor(monthly([90, 90, 90])).fixed('hydro'), 'three posted payments of exactly the plan amount: fixed');
  ok(fixedFor(monthly([80, 85, 90, 90, 90, 90, 90, 90])).fixed('hydro'), 'eight payments, the latest six all 90: fixed (only the last six count)');
  ok(!fixedFor(monthly([90, 90, 90, 90, 90, 90, 90, 85])).fixed('hydro'), 'the newest payment changed to 85: not fixed (a price change turns it off)');
  ok(!fixedFor(monthly([90, 90, 85, 90, 90, 90])).fixed('hydro'), 'one of the last six differs: not fixed');
  ok(!fixedFor(monthly([95, 95, 95])).fixed('hydro'), 'identical, but 95 against a plan amount of 90: not fixed');
  ok(!fixedFor(monthly([90, 90])).fixed('hydro'), 'only two payments: not fixed');
  ok(!fixedFor(monthly([90, 90, 90], 7)).fixed('hydro'), 'newest payment Jul 12, more than two months before Oct 14: not fixed (stale)');
  // Two monthly intervals are 62 days. By hand: Aug 13 to Oct 14 is 18 + 30 + 14 = 62 days, Aug 12 is 63.
  const ending = last => [pay(90, '2026-06-13'), pay(90, '2026-07-13'), pay(90, last)];
  ok(fixedFor(ending('2026-08-13')).fixed('hydro'), 'newest payment Aug 13, exactly 62 days before Oct 14: fixed');
  ok(!fixedFor(ending('2026-08-12')).fixed('hydro'), 'newest payment Aug 12, 63 days before Oct 14: not fixed');
}

console.log('2. Only identified posted CAD payments on the rule\'s own account count');
{
  const base = monthly([90, 90]);
  ok(!fixedFor(base.concat(pay(90, '2026-09-12', { account: 'chequing-b' }))).fixed('hydro'), 'a third 90 on another account does not count');
  ok(!fixedFor(base.concat(pay(90, '2026-09-12', { pending: true }))).fixed('hydro'), 'a pending third 90 does not count');
  ok(!fixedFor(base.concat(pay(90, '2026-09-12', { raw: { currency: 'usd' } }))).fixed('hydro'), 'a USD third 90 does not count');
  ok(!fixedFor(base.concat(pay(90, '2026-09-12', { payee: 'Invented water' }))).fixed('hydro'), 'a 90 from another payee does not count');
  ok(!fixedFor(monthly([90, 90, 90]).concat(pay(90, '2026-09-12'))).fixed('hydro'), 'two payments on one day: not fixed (legs or a duplicate)');
}

console.log('3. Uncertain rules and bills are never fixed');
{
  const twoBills = fixedFor(monthly([90, 90, 90]), { bills: [HYDRO, { ...HYDRO, id: 'hydro2', label: 'Invented hydro two', payee: 'hydro' }] });
  ok(!twoBills.fixed('hydro') && !twoBills.fixed('hydro2'), 'a row two bills\' rules both identify fixes neither');
  ok(!fixedFor(monthly([90, 90, 90]), { bills: [{ ...HYDRO, rule: { settlesWhen: 'two-leg-sum' } }] }).fixed('hydro'), 'a two-leg rule: not fixed');
  ok(!fixedFor(monthly([90, 90, 90]), { bills: [{ ...HYDRO, rule: { settlesWhen: 'amount-at-least' } }] }).fixed('hydro'), 'a minimum-style rule: not fixed');
  ok(!fixedFor(monthly([90, 90, 90]), { bills: [{ ...HYDRO, frequency: 'once', date: '2026-10-12' }] }).fixed('hydro'), 'a once bill: never fixed');
}

console.log('4. Fail closed, and no hand mark survives');
{
  for (const [label, extra] of [['incomplete', { coverage: { complete: false } }], ['truncated', { coverage: { truncated: true } }],
    ['has more pages', { coverage: { hasMore: true } }]]) {
    const s = fixedFor(monthly([90, 90, 90]), { historyExtra: extra });
    ok(!s.fixed('hydro') && s.report.derivedAmountFixed.status === 'unavailable', `a history window that is ${label}: nothing fixed, status unavailable`);
  }
  const noRead = serve({ bills: [{ ...HYDRO, amountFixed: true }] });
  ok(!noRead.fixed('hydro') && !Object.hasOwn(noRead.plan.bills[0], 'amountFixed') && !Object.hasOwn(noRead.report, 'derivedAmountFixed'),
    'no history read: a hand amountFixed mark is dropped from the served plan, and the report carries no derivation');
  const handVaries = fixedFor(monthly([90, 90, 85]), { bills: [{ ...HYDRO, amountFixed: true }] });
  ok(!handVaries.fixed('hydro'), 'a hand mark on a bill whose history varies: not fixed (the history decides)');
  const data = require('../data.json');
  ok(!(data.plan.bills || []).some(b => b && Object.hasOwn(b, 'amountFixed')), 'data.json carries no hand amountFixed mark');
}

console.log('5. The history read moves nothing but the flag');
{
  // The same world with and without the read. Hydro is paid in full on Oct 12, so D2 has no remainder to hold: every
  // served figure, the observation report and the whole recommend() output must be identical once the amountFixed key
  // itself (and the report's derivation record) is set aside.
  const strip = v => JSON.parse(JSON.stringify(v, (k, x) => (k === 'amountFixed' || k === 'derivedAmountFixed' ? undefined : x)));
  const txs = [pay(90, '2026-10-12'), H.lm({ date: '2026-10-13', amount: 42, category: 'Groceries', payee: 'Invented grocer' })];
  const without = serve({ transactions: txs });
  const withRead = fixedFor(monthly([90, 90, 90]).concat(monthly([110, 110, 110]).map(t => ({ ...t, payee: 'Invented other' }))),
    { transactions: txs });
  ok(withRead.fixed('hydro') && !without.fixed('hydro'), 'control: the read derives the flag, and without it there is none');
  const recOf = s => F.recommend(s.plan, s.w.asOf, { currentPeriodActuals: s.result.data.liveOverlay.currentPeriodActuals, debts: s.result.data.debts });
  const same = (a, b) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));
  ok(same(without.result.data, withRead.result.data), 'the served data is identical apart from amountFixed');
  ok(same(without.report, withRead.report), 'the observation report is identical apart from the derivation record');
  ok(same(recOf(without), recOf(withRead)), 'every figure, tag and claim in recommend() is identical apart from amountFixed');
}

console.log('6. The fetch: one bounded GET, only when asked, and a failure fixes nothing');
(async () => {
  const seen = [];
  const routes = (txStatus) => (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    const p = url.pathname.replace(/^\/v2/, '');
    const body = { '/me': { account_id: 1 }, '/plaid_accounts': { plaid_accounts: [] }, '/manual_accounts': { manual_accounts: [] },
      '/categories': { categories: [] }, '/tags': { tags: [] }, '/recurring_items': [] }[p];
    if (p === '/transactions') {
      const long = url.searchParams.get('start_date') === '2026-03-28';
      if (long && txStatus !== 200) { res.writeHead(txStatus); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ transactions: [], has_more: false }));
      return;
    }
    if (body === undefined) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const run = async (txStatus, options) => {
    seen.length = 0;
    const server = http.createServer(routes(txStatus));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      return await O.fetchLunchMoneyLive('invented-token', '2026-10-14T18:00:00.000Z', 14,
        { env: { ATLAS_LUNCHMONEY_API_BASE: `http://127.0.0.1:${server.address().port}/v2` }, ...options });
    } finally { await new Promise(r => server.close(r)); }
  };
  const asked = await run(200, { amountHistory: true });
  const long = seen.filter(r => r.path.endsWith('/transactions') && r.query.start_date === '2026-03-28');
  ok(asked.amountHistory && asked.amountHistory.transactionWindow.complete === true
    && asked.amountHistory.transactionWindow.startDate === '2026-03-28' && asked.amountHistory.transactionWindow.endDate === '2026-10-14',
    'asked: the payload carries a complete 200-day history (Mar 28 to Oct 14)', JSON.stringify(asked.amountHistory && asked.amountHistory.transactionWindow));
  ok(long.length >= 1 && seen.every(r => r.method === 'GET'), 'every request is a GET, and one of them is the 200-day transactions read');
  const notAsked = await run(200, {});
  ok(!Object.hasOwn(notAsked, 'amountHistory') && !seen.some(r => r.query.start_date === '2026-03-28'),
    'not asked: no 200-day read and no amountHistory (every other caller is unchanged)');
  const failed = await run(503, { amountHistory: true });
  ok(failed.amountHistory && failed.amountHistory.transactionWindow.complete === false && Array.isArray(failed.transactions),
    'the 200-day read fails: the refresh still returns, with the history marked incomplete (nothing will be fixed)');
  ok(O.derivedAmountFixedBills(failed.amountHistory, { plan: { bills: [HYDRO] }, accountMap: { mappings: [] }, identityRules: [] }).billIds.length === 0,
    'and the derivation over that failed read fixes no bill');

  if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
  console.log('\nAll derived amountFixed checks passed.');
})().catch(err => { console.error(err); process.exit(1); });
