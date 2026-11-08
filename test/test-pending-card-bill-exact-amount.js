'use strict';
// Budget audit (PR 2): a pending card charge occupies a still-due card-paid
// bill only at the bill's exact scheduled amount. A same-payee pending
// charge at a different amount (a new price) is not that bill: the charge
// stays counted as card spending and the bill stays due. This is the
// conservative reading: it never hides money; at worst the household sees
// both until the charge posts or is confirmed.
//
// Invented household from test/acceptance/harness.js, through the real
// observer (scripts/provider-observe.js via scripts/live-plan.js) and the
// real Budget page in headless Chromium. Expected figures are hand-derived
// from the invented inputs; nothing here computes an expectation with Atlas
// code. No household figure enters this file.
//
//   Base: income 1,400; plan Groceries 300 + Eating out 100; a 9.99
//   card-paid streaming bill due Oct 13. With nothing posted, BAD is
//   1,400 - 400 - 9.99 = 990.01.
//
//   1. pending 14.99 from the same payee on Oct 13: not the bill.
//      BAD = 990.01 - 14.99 = 975.02; the charge is listed as spending.
//   2. pending 4.99 (lower): not the bill. BAD = 990.01 - 4.99 = 985.02.
//   3. control: pending exactly 9.99 occupies the bill, counted once:
//      BAD 990.01; the charge is not also spending.
//   4. control: no charge at all: BAD 990.01.
//   5-6. case 1 with the charge labelled Subscriptions, or Bills: the label
//      does not hide it (BAD 975.02, note shown).
//   7-9. cases 1-3 under an explicit exact-scheduled-amount identity rule:
//      the near misses are counted and disclosed; the exact price pairs.
//
// A near-miss charge (cases 1 and 2) carries a visible note on the page:
// "Possibly <bill> at a new price — to confirm; the bill is still counted
// too". So BAD may be understated by up to the bill amount until the
// household confirms, and the page says why.
//
// Each case runs twice: through Forecast on the served document (always,
// so `npm test` holds the proof without a browser), then through the
// rendered Budget page when Playwright's Chromium is available.
//
//   node test/test-pending-card-bill-exact-amount.js
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');

const SUBSCRIPTIONS = 112, BILLS = 114;
function world(pendingAmount, variant) {
  const v = variant || {};
  const w = H.baseWorld();
  w.categories.push({ id: SUBSCRIPTIONS, name: 'Subscriptions' }, { id: BILLS, name: 'Bills' });
  w.accounts.push({ id: 'card-a', providerId: 9004, role: 'revolving-credit', collection: 'debts', label: 'Invented card', value: 0 });
  w.debts = [{ id: 'card-a', label: 'Invented card', structure: 'Revolving', secured: false, balance: 0,
    pending: 0, rate: 0, limit: 2000, statementCloseDay: 17 }];
  w.planPatch = plan => { plan.cardPurchaseCoverage = { rule: 'aggregate-per-card-per-pay-period',
    opening: { asOf: '2026-10-09', confirmed: true, currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] } }; };
  w.bills = [{ id: 'stream', label: 'Invented streaming', amount: 9.99, frequency: 'monthly', day: 13,
    confidence: 'confirmed', payee: 'Invented streamer', account: 'card-a', payingAccount: 'card-a', jointCash: false,
    ...(v.settlesWhen ? { rule: { settlesWhen: v.settlesWhen } } : {}) }];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  // Globally incomplete evidence: one unrelated, stable-id cash row whose
  // amount is unreadable (Spent is withheld; the page falls back to the
  // raw packet rows).
  if (v.incomplete) w.transactions.push(H.lm({ id: 700901, date: '2026-10-11', amount: 'unavailable',
    category: 'Uncategorised', account: 'chequing-b', payee: 'Invented unreadable row' }));
  if (pendingAmount != null) {
    w.transactions.push(H.lm({ date: '2026-10-13', amount: pendingAmount, account: 'card-a', providerAccountId: 9004,
      payee: 'Invented streamer', pending: true, ...(v.category ? { category: v.category } : {}) }));
  }
  return w;
}
// Forecast on the served document: the same plan and packet the page reads.
function engine(w) {
  const { data, packet, error } = H.dataOf(w);
  H.expect(error == null, 'the observation is applied');
  const view = F.recommend(data.plan, w.asOf, { debts: data.debts, currentPeriodActuals: packet })
    .payPeriodViews.find(r => r.start === '2026-10-09');
  const charge = (packet.transactions || []).find(t => t && t.pending === true) || null;
  return { bad: view.balanceAfterDeductions, charge };
}
async function badOf(p) {
  return ((await p.rows('[data-operating-question="07"]')).join(' ')
    .match(/Balance After Deductions[^$]*(\$[\d,]+\.\d\d)/) || [])[1] || '';
}

const cases = [
  { name: 'a pending charge at a higher new price is not the bill and stays counted', amount: 14.99,
    bad: 975.02, page: '$975.02', occupies: false },
  { name: 'a pending charge at a lower price is not the bill and stays counted', amount: 4.99,
    bad: 985.02, page: '$985.02', occupies: false },
  { name: 'control: a pending charge at exactly the bill amount is the bill, counted once', amount: 9.99,
    bad: 990.01, page: '$990.01', occupies: true },
  { name: 'control: with no charge the bill alone is deducted', amount: null,
    bad: 990.01, page: '$990.01', occupies: null },
  // Atlas #915 blocker 1: a bill-type category label must not hide the
  // near-miss charge.
  { name: 'a higher-price pending charge labelled Subscriptions is not hidden', amount: 14.99,
    variant: { category: SUBSCRIPTIONS }, bad: 975.02, page: '$975.02', occupies: false },
  { name: 'a higher-price pending charge labelled Bills is not hidden', amount: 14.99,
    variant: { category: BILLS }, bad: 975.02, page: '$975.02', occupies: false },
  // Atlas #915 blocker 2: an explicit exact-scheduled-amount identity rule
  // still discloses the near miss, and still pairs the exact price.
  { name: 'exact-amount rule: a higher-price pending charge is counted and disclosed', amount: 14.99,
    variant: { settlesWhen: 'exact-scheduled-amount' }, bad: 975.02, page: '$975.02', occupies: false },
  { name: 'exact-amount rule: a lower-price pending charge is counted and disclosed', amount: 4.99,
    variant: { settlesWhen: 'exact-scheduled-amount' }, bad: 985.02, page: '$985.02', occupies: false },
  { name: 'exact-amount rule control: the exact price still occupies the bill', amount: 9.99,
    variant: { settlesWhen: 'exact-scheduled-amount' }, bad: 990.01, page: '$990.01', occupies: true },
  // Atlas #915 second finding: with globally incomplete evidence the
  // withheld-Spent fallback still shows the disclosure. BAD is unavailable
  // there by design, so only the note and the marker are asserted.
  ...[[SUBSCRIPTIONS, 'Subscriptions'], [BILLS, 'Bills']].flatMap(([category, label]) => [14.99, 4.99].map(amount => ({
    name: `incomplete evidence: a ${amount} pending charge labelled ${label} keeps the new-price note`, amount,
    variant: { settlesWhen: 'exact-scheduled-amount', category, incomplete: true }, bad: null, page: null, occupies: false,
  }))),
];

function hasBrowser() {
  try { require.resolve('playwright'); return true; } catch { return false; }
}

(async () => {
  let failures = 0;
  const report = (name, fn) => fn().then(() => console.log('  PASS  ' + name),
    err => { failures++; console.log('  FAIL  ' + name + ' -- ' + String(err && err.message || err).split('\n')[0]); });
  for (const c of cases) {
    await report('engine: ' + c.name, async () => {
      const r = engine(world(c.amount, c.variant));
      if (c.bad != null) H.expect(Math.abs(r.bad - c.bad) < 0.005, `BAD is ${c.bad} (got ${r.bad})`);
      if (c.occupies != null) {
        H.expect(!!r.charge, 'the pending charge is in the packet');
        H.expect((r.charge.pendingMatchingCardPaidBill === true) === c.occupies,
          `the charge ${c.occupies ? 'occupies' : 'does not occupy'} the bill (flag ${r.charge.pendingMatchingCardPaidBill})`);
        const marked = !!(r.charge.pendingPossibleCardPaidBill && r.charge.pendingPossibleCardPaidBill.id === 'stream');
        H.expect(marked === !c.occupies, `the near-miss marker is ${c.occupies ? 'absent' : 'present'} (got ${marked})`);
      }
    });
  }
  if (!hasBrowser() || process.env.ATLAS_SKIP_BROWSER === '1') {
    console.log('  SKIP  rendered-page cases: Playwright Chromium is not available here');
  } else {
    for (const c of cases) {
      await report('page: ' + c.name, () => H.withBudget(world(c.amount, c.variant), async p => {
        const s = await H.snap(p);
        H.expectMatch(H.bill(s, 'Invented streaming'), /\$9\.99/, 'the bill row shows its scheduled 9.99');
        if (c.occupies === false) {
          H.expectIncludes(s.household, 'Invented streamer', 'the charge is listed as spending');
          // The possible double count is disclosed, not silent.
          H.expectIncludes(s.household, 'Possibly Invented streaming at a new price — to confirm',
            'the charge says it may be the bill at a new price');
        } else {
          H.expectExcludes(s.all, 'at a new price', 'no price-change note without a near-miss charge');
        }
        if (c.occupies === true) H.expectExcludes(s.household, 'Invented streamer', 'the bill charge is not also spending');
        if (c.page != null) {
          const bad = await badOf(p);
          H.expect(bad === c.page, `Balance After Deductions shows ${c.page} (got ${bad || 'nothing'})`);
        }
      }));
    }
    await H.closeBrowser();
  }
  console.log(failures ? `\n${failures} failure(s)` : '\nall cases pass');
  process.exit(failures ? 1 : 0);
})();
