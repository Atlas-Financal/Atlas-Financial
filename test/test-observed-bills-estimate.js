'use strict';
/* C5 follow-up: a stale owner-estimate tag on the Bills (chequing-a) opening
 * row never survives a refresh whose bank feed actually observed the account.
 *
 * Owner decision 2026-11-08 ("ok #873", relayed by the lead): a Bills balance
 * reads provider-confirmed only when the live overlay observed that account on
 * this refresh with fresh, trustworthy evidence; otherwise it stays estimated
 * (C5, #787 6621905431).
 *
 * Path under test: invented canonical document + invented provider payload ->
 * scripts/live-plan.js fromObservation (the production overlay) -> Forecast's
 * Current Balance publication. Every amount is invented. The oracle is the
 * stated rule and the invented inputs, never the code under test.
 *
 * `node test/test-observed-bills-estimate.js`
 */
const H = require('./acceptance/harness');
const Live = require('../scripts/live-plan');
const Forecast = require('../public/forecast');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

// One invented world per case: Bills canonical row tagged 'estimated'.
function world({ canonicalBills, providerBills, providerReturnsBills = true, providerDate, mutate } = {}) {
  const w = H.baseWorld();
  w.bills = [];
  const bills = w.accounts.find(a => a.id === 'chequing-a');
  bills.confidence = 'estimated';
  bills.value = providerBills;
  const plan = H.planOf(w);
  plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value = canonicalBills;
  const payload = H.rawPayload(w);
  if (!providerReturnsBills) {
    payload.plaid_accounts = payload.plaid_accounts.filter(a => String(a.id) !== String(bills.providerId));
  } else if (providerDate) {
    const acct = payload.plaid_accounts.find(a => String(a.id) === String(bills.providerId));
    acct.balance_last_update = providerDate + 'T12:00:00.000Z';
  }
  const data = { meta: { asOf: w.asOf, title: 'Invented C5 follow-up household' },
    accounts: [], debts: [], revolvingExtra: [], plan };
  if (mutate) mutate({ data, payload, providerAccount: payload.plaid_accounts.find(a => String(a.id) === String(bills.providerId)) });
  return { w, data, payload };
}

function run(c) {
  try {
    const result = Live.fromObservation({ data: c.data, payload: c.payload,
      accountMap: H.accountMapOf(c.w), identity: H.identityOf(c.w) });
    return { data: result.data, error: null };
  } catch (error) {
    // A refused overlay serves the canonical document unchanged (server.js).
    return { data: c.data, error };
  }
}

const row = d => d.plan.startingCash.breakdown.find(r => r.id === 'chequing-a');
const publication = (d, asOf) => Forecast.paydayAllocation(d.plan, asOf, {}).currentBalancePublication;

console.log('=== A. Bank observes the Bills account today, value changed (CHANGE) ===');
{
  // Owner estimate 2,000.00; the bank feed returns 2,345.67 today.
  const c = world({ canonicalBills: 2000, providerBills: 2345.67 });
  const out = run(c);
  const pub = publication(out.data, c.w.asOf);
  ok(!out.error && out.data.liveOverlay && out.data.liveOverlay.applied === true,
    'the live overlay applied', out.error ? out.error.message : '');
  ok(row(out.data).value === 2345.67, 'the Bills row takes the observed 2,345.67');
  ok(row(out.data).confidence !== 'estimated', 'the stale estimate tag is removed');
  ok(pub.trust === 'posted' && pub.providerConfirmed === true && pub.note == null && pub.amount === 2345.67,
    'Current Balance is the observed 2,345.67, posted and provider-confirmed, with no estimate note');
}

console.log('=== B. Bank observes the Bills account today, value equals the estimate (MATCH) ===');
{
  // The observation proves the balance even when it equals the estimate:
  // no CHANGE row is proposed, so the rule must not key on "value changed".
  const c = world({ canonicalBills: 2000, providerBills: 2000 });
  const out = run(c);
  const pub = publication(out.data, c.w.asOf);
  ok(!out.error && out.data.liveOverlay && out.data.liveOverlay.applied === true,
    'the live overlay applied', out.error ? out.error.message : '');
  ok(!(out.data.liveOverlay.overlays || []).some(o => o.locator === 'cash:chequing-a'),
    'precondition: no Bills value change was proposed (MATCH)');
  ok(row(out.data).confidence !== 'estimated', 'the stale estimate tag is removed on a MATCH too');
  ok(pub.trust === 'posted' && pub.providerConfirmed === true && pub.note == null,
    'Current Balance is posted and provider-confirmed');
}

console.log('=== C. Bank feed does not return the Bills account ===');
{
  const c = world({ canonicalBills: 2000, providerBills: 2000, providerReturnsBills: false });
  const out = run(c);
  const pub = publication(out.data, c.w.asOf);
  ok(row(out.data).confidence === 'estimated', 'the estimate tag is kept');
  ok(pub.trust === 'estimated' && pub.providerConfirmed === false && /Not provider-confirmed/.test(pub.note || ''),
    'Current Balance stays an estimate, never provider-confirmed (C5)');
}

console.log('=== D. Bank returns the Bills account only with an older balance date ===');
{
  // A provider row dated before today is not a fresh observation.
  const c = world({ canonicalBills: 2000, providerBills: 2000, providerDate: '2026-10-01' });
  const out = run(c);
  const pub = publication(out.data, c.w.asOf);
  ok(row(out.data).confidence === 'estimated', 'a stale provider balance does not remove the estimate tag',
    out.error ? 'overlay refused: ' + out.error.message.split('\n')[0] : 'overlay applied');
  ok(pub.trust === 'estimated' && pub.providerConfirmed === false,
    'Current Balance stays an estimate on stale evidence');
}

console.log('=== E. Fresh bank CHANGE that the overlay refuses: the row still holds the estimate ===');
{
  // Pre-review blocker on dae6a23: a fresh, trustworthy provider row is not
  // enough. Here the canonical document has no meta.asOf, so the overlay
  // refuses the Bills CHANGE (incomparable freshness) and the row keeps the
  // owner's 2,000.00 estimate. That estimate must never read as
  // provider-confirmed: the bank reported 2,345.67.
  const c = world({ canonicalBills: 2000, providerBills: 2345.67, mutate: ({ data }) => { delete data.meta.asOf; } });
  const out = run(c);
  const pub = publication(out.data, c.w.asOf);
  ok(row(out.data).value === 2000, 'precondition: the refused CHANGE left the estimate 2,000.00 in the row');
  ok(row(out.data).confidence === 'estimated', 'the estimate tag is kept when the observed value was not applied');
  ok(pub.trust === 'estimated' && pub.providerConfirmed === false,
    'Current Balance stays an estimate; the estimate is never published as provider-confirmed');
}

console.log('=== F. Bank row for Bills dated today but with an unusable balance ===');
{
  // An unknown provider value is not an observation of the balance.
  const c = world({ canonicalBills: 2000, providerBills: 2000, mutate: ({ providerAccount }) => { providerAccount.balance = 'n/a'; } });
  const out = run(c);
  const pub = publication(out.data, c.w.asOf);
  ok(row(out.data).confidence === 'estimated', 'an unknown provider balance does not remove the estimate tag');
  ok(pub.trust === 'estimated' && pub.providerConfirmed === false, 'Current Balance stays an estimate');
}

console.log('\n' + '═'.repeat(60));
if (failures) {
  console.log(`FAILED — ${failures} observed-Bills-estimate check(s)`);
  process.exit(1);
}
console.log('ALL OBSERVED-BILLS-ESTIMATE CHECKS PASSED');
