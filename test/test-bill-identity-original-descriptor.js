'use strict';
// Invented data only. A bill payment's identity survives a Lunch Money
// displayed-payee rename: descriptor-fragment payee patterns on household
// debit rules read the bank's original descriptor (never rewritten by Lunch
// Money); a rename can neither break that match nor forge one.
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const root = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const Observer = require(path.join(root, 'scripts/provider-observe'));
const F = require(path.join(root, 'public/forecast'));
const Live = require(path.join(root, 'scripts/live-plan'));
const fixture = require('./fixtures/shaw-posted-identity');
const configured = require(path.join(root, 'docs/connectivity/transaction-identity.json'));

const STORAGE = { eventId: 'cloud-storage', payeePatterns: ['GOOGLE *STORAGE'],
  atlasAccountId: 'chequing-a', direction: 'debit' };
const PHOTOS = { eventId: 'cloud-photos', payeePatterns: ['GOOGLE *PHOTOS'],
  atlasAccountId: 'chequing-a', direction: 'debit' };
const GUARDED = { eventId: 'guarded', payeePatterns: ['Cable'], payeeMatchMode: 'exact',
  originalNamePatterns: ['INVENTED CABLE BPY'], atlasAccountId: 'chequing-a', direction: 'debit' };
// Stamped as the observer stamps a whole observation: against the complete rule set.
const tx = (payee, originalName, extra = {}) =>
  Observer.stampIdentityDescriptors([{ payee, originalName, ...extra }], [STORAGE, PHOTOS, GUARDED])[0];
const hit = (t, rule = STORAGE) => Observer.ruleMatchesTransactionIdentity(t, rule);

test('acceptance: bank descriptor matches, survives rename, and a rename cannot forge a match', () => {
  assert.equal(hit(tx('GOOGLE *STORAGE', 'GOOGLE *STORAGE G.CO/HELPPAY')), true, 'unrenamed payment matches');
  assert.equal(hit(tx('Cloud storage', 'GOOGLE *STORAGE G.CO/HELPPAY')), true, 'renamed payment still matches');
  assert.equal(hit(tx('GOOGLE *STORAGE', 'INVENTED STREAMING CO')), false,
    'an unrelated payment renamed to the rule pattern does not match');
  assert.equal(hit(tx('Cloud storage', 'INVENTED STREAMING CO')), false,
    'an unrelated payment renamed to the bill display name does not match');
});

test('adversarial: a rename to another bill\'s name does not move identity', () => {
  const t = tx('GOOGLE *PHOTOS', 'GOOGLE *STORAGE G.CO/HELPPAY');
  assert.equal(hit(t, STORAGE), true, 'stays with the bill its descriptor names');
  assert.equal(hit(t, PHOTOS), false, 'does not newly match the other bill');
});

test('adversarial: two bills sharing a merchant prefix stay separate', () => {
  const storage = tx('Google', 'GOOGLE *STORAGE G.CO'), photos = tx('Google', 'GOOGLE *PHOTOS G.CO');
  assert.deepEqual([hit(storage, STORAGE), hit(storage, PHOTOS)], [true, false]);
  assert.deepEqual([hit(photos, STORAGE), hit(photos, PHOTOS)], [false, true]);
  const broad = { ...STORAGE, eventId: 'broad', payeePatterns: ['GOOGLE'] };
  assert.equal(hit(storage, broad) && hit(photos, broad), true,
    'a broad prefix rule is as broad on descriptors as it was on payees; uniqueness gates downstream are unchanged');
});

test('adversarial: no original descriptor falls back to the displayed payee exactly as before', () => {
  assert.equal(hit(tx('GOOGLE *STORAGE', null)), true);
  assert.equal(hit(tx('Cloud storage', null)), false, 'without a descriptor a rename cannot be seen through');
  assert.equal(hit(tx('GOOGLE *STORAGE', '   ')), true, 'blank descriptor is no descriptor');
});

test('displayed-form rules (exact mode, separate original gate) keep the displayed reading', () => {
  const exact = { eventId: 'x', payeePatterns: ['Cloud storage'], payeeMatchMode: 'exact',
    atlasAccountId: 'chequing-a', direction: 'debit' };
  assert.equal(hit(tx('Cloud storage', 'GOOGLE *STORAGE G.CO'), exact), true);
  assert.equal(hit(tx('Other', 'Cloud storage'), exact), false);
  const gated = { eventId: 'g', payeePatterns: ['Google'], originalNamePatterns: ['SERVICE _V'],
    atlasAccountId: 'chequing-a', direction: 'debit' };
  assert.equal(hit(tx('Google', 'SERVICE _V'), gated), true);
  assert.equal(hit(tx('Cloud storage', 'SERVICE _V'), gated), false, 'gated displayed payee is still identity');
});

test('a descriptor claimed by a guarded rule keeps the displayed reading for every rule', () => {
  const sibling = { eventId: 'guarded', payeePatterns: ['INVENTED CABLE BPY'], atlasAccountId: 'chequing-a', direction: 'debit' };
  assert.equal(hit(tx('Cable', 'INVENTED CABLE BPY'), sibling), false,
    'unguarded sibling cannot take the guarded descriptor past the guarded gates');
  assert.equal(hit(tx('Cable', 'INVENTED CABLE BPY'), GUARDED), true, 'guarded rule unchanged');
  assert.equal(hit(tx('Home internet', 'INVENTED CABLE BPY'), GUARDED), false,
    'guarded rule still requires its displayed payee (known limit)');
  assert.equal(hit(tx('INVENTED CABLE BPY', 'INVENTED CABLE BPY'), sibling), true, 'displayed route as before');
});

test('an unstamped transaction keeps the incumbent displayed reading', () => {
  assert.equal(hit({ payee: 'Cloud storage', originalName: 'GOOGLE *STORAGE' }), false);
  assert.equal(hit({ payee: 'GOOGLE *STORAGE', originalName: 'INVENTED STREAMING CO' }), true);
});

test('exclusions still read both fields; credit rules are untouched', () => {
  const excl = { ...STORAGE, payeeExcludePatterns: ['REFUND'] };
  assert.equal(hit(tx('Storage REFUND', 'GOOGLE *STORAGE'), excl), false, 'displayed exclusion still applies');
  assert.equal(hit(tx('Cloud storage', 'GOOGLE *STORAGE REFUND'), excl), false, 'original exclusion still applies');
  const credit = { eventId: 'pay', payeePatterns: ['INVENTED EMPLOYER'], atlasAccountId: 'chequing-a', direction: 'credit' };
  assert.equal(hit(tx('Paycheque', 'INVENTED EMPLOYER PAY'), credit), false, 'credit identity reads displayed, as before');
  assert.equal(hit(tx('INVENTED EMPLOYER', 'X'), credit), true);
});

test('pending classification sees the original descriptor through a rename', () => {
  const plan = { bills: [{ label: 'Invented Phone Co' }] };
  assert.equal(Observer.isBillOrPaymentTransaction(tx('Mobile', 'INVENTED PHONE CO 555'), plan), true);
  assert.equal(Observer.isBillOrPaymentTransaction(tx('Mobile', 'BILL PAYMENT 0042'), plan), true);
  assert.equal(Observer.isBillOrPaymentTransaction(tx('Invented Phone Co', null), plan), true, 'displayed path unchanged');
  assert.equal(Observer.isBillOrPaymentTransaction(tx('Coffee', 'INVENTED CAFE'), plan), false);
  assert.equal(Observer.isBillOrPaymentTransaction(tx('Coffee', 'CO'), plan), false,
    'a short descriptor is never matched by being inside a longer bill label');
  const asOf = '2031-06-01', old = { pending: true, date: '2031-02-01' };
  const agedTx = Observer.stampIdentityDescriptors([{ ...old, payee: 'Mobile', originalName: 'INVENTED PHONE CO 555' }], [])[0];
  const aged = Observer.pendingForecastTreatment(agedTx, asOf, { plan });
  assert.equal(aged.treatment, 'presumed-settled-for-current-forecast');
  assert.equal(aged.confidence, 'inferred', 'trust tag stays inferred');
});

// Full path a household reads: observation -> live overlay -> Forecast bill row.
// Invented unguarded descriptor rule on the invented Shaw-shaped fixture.
const CABLE = { eventId: 'shaw', payeePatterns: ['INVENTED CABLE CO'], atlasAccountId: 'chequing-a',
  direction: 'debit', postingDateRule: 'covers-early-or-due-on-or-before-posting' };
function shawInput(payee, originalName, rules = [CABLE]) {
  const x = fixture('04', payee);
  if (originalName === undefined) delete x.payload.transactions[0].original_name;
  else x.payload.transactions[0].original_name = originalName;
  return { ...x, identity: { schema: configured.schema, rules: JSON.parse(JSON.stringify(rules)) } };
}
function shawRun(x) {
  const live = Live.fromObservation(x);
  const packet = live.data.liveOverlay.currentPeriodActuals;
  const advice = F.recommend(live.data.plan, x.asOf, { debts: [], currentPeriodActuals: packet, weeklyVariable: 0 });
  const period = advice.payPeriodViews.find(p => p.start <= x.asOf && p.end >= x.asOf);
  return { bill: period.bills.find(b => b.id === 'shaw'),
    hits: live.report.representedEventCandidates.filter(c => c.id === 'shaw') };
}
test('full path: renamed bank-descriptor bill payment is one PAID bill', () => {
  const r = shawRun(shawInput('Home internet', 'INVENTED CABLE CO 0042'));
  assert.equal(r.hits.length, 1); assert.equal(r.bill.status, 'PAID'); assert.equal(r.bill.actual, 17.23);
});
test('full path: unrelated descriptor renamed to the bill name does not settle', () => {
  const r = shawRun(shawInput('INVENTED CABLE CO', 'INVENTED UNRELATED DESCRIPTOR'));
  assert.equal(r.hits.length, 0); assert.notEqual(r.bill.status, 'PAID');
});
test('full path: committed guarded Shaw rules keep their incumbent result', () => {
  const shaw = configured.rules.filter(r => r.eventId === 'shaw');
  assert.equal(shawRun(shawInput('Shaw', 'SHAW CABLE TV BPY', shaw)).bill.status, 'PAID');
  assert.notEqual(shawRun(shawInput('Home internet', 'SHAW CABLE TV BPY', shaw)).bill.status, 'PAID',
    'guarded descriptor: a rename is not seen through (known limit, unchanged)');
});
test('full path: no descriptor keeps the displayed payee route', () => {
  assert.equal(shawRun(shawInput('INVENTED CABLE CO', undefined)).bill.status, 'PAID');
});

test('adversarial: pending-to-posted pair with only one leg renamed stays one settlement', () => {
  for (const [pendingPayee, postedPayee] of [['Home internet', 'INVENTED CABLE CO'], ['INVENTED CABLE CO', 'Home internet']]) {
    const x = shawInput(postedPayee, 'INVENTED CABLE CO 0042');
    const posted = x.payload.transactions[0];
    posted.plaid_metadata = { transaction_id: 'invented-plaid-posted', pending_transaction_id: 'invented-plaid-pending' };
    x.payload.transactions.unshift({ ...posted, id: 'invented-shaw-pending', is_pending: true, payee: pendingPayee,
      date: '2031-04-13', plaid_metadata: { transaction_id: 'invented-plaid-pending' } });
    const r = shawRun(x);
    assert.equal(r.hits.length, 1, 'one candidate for ' + pendingPayee + ' -> ' + postedPayee);
    assert.equal(r.bill.status, 'PAID'); assert.equal(r.bill.actual, 17.23, 'counted once');
  }
});
