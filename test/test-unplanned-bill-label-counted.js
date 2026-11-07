'use strict';
// Budget audit (PR 1): a bill-type category label alone (Insurance,
// Subscriptions, ...) does not make a row a bill. A row is a bill only when
// it matches a planned bill; an unmatched one stays visible in Other
// spending (needs confirmation) and is deducted from Balance After
// Deductions.
//
// Invented household from test/acceptance/harness.js, through the real
// observer (scripts/provider-observe.js via scripts/live-plan.js) and the
// real Budget page in headless Chromium. Expected figures are hand-derived
// from the invented inputs; nothing here computes an expectation with Atlas
// code. No household figure enters this file.
//
//   Base: income 1,400; plan Groceries 300 + Eating out 100; so
//   Balance After Deductions (BAD) = 1,400 - 400 = 1,000.
//
//   1. unplanned 240.00 "Insurance" debit on chequing      -> BAD 760.00
//   2. unplanned 15.99 "Subscriptions" debit on chequing   -> BAD 984.01
//   3. unplanned 15.99 "Subscriptions" charge on the card  -> BAD 984.01
//   4. control: a planned 240.00 insurance bill paid on its
//      date and labelled "Insurance" is the bill, counted once:
//      BAD = 1,400 - 400 - 240 = 760.00, and it is not in Other.
//   5. control: the owner's budget exclusion still wins over the label.
//   6. a PENDING unplanned 300.00 "Insurance" debit on chequing is
//      encumbered like any pending spend: BAD 1,000 - 300 = 700.00, and
//      the payday protected path (Prepare Ahead) wants and moves exactly
//      what it does for the same debit labelled "Shopping".
//
// Each case runs twice: through Forecast on the served document (always,
// so `npm test` holds the proof without a browser), then through the
// rendered Budget page when Playwright's Chromium is available.
//
//   node test/test-unplanned-bill-label-counted.js
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');

const INSURANCE = 111, SUBSCRIPTIONS = 112, SHOPPING = 113;
function world(card) {
  const w = H.baseWorld();
  w.categories.push({ id: INSURANCE, name: 'Insurance' }, { id: SUBSCRIPTIONS, name: 'Subscriptions' }, { id: SHOPPING, name: 'Shopping' });
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  if (card) {
    w.accounts.push({ id: 'card-a', providerId: 9004, role: 'revolving-credit', collection: 'debts', label: 'Invented card', value: 0 });
    w.debts = [{ id: 'card-a', label: 'Invented card', structure: 'Revolving', secured: false, balance: 0,
      pending: 0, rate: 0, limit: 2000, statementCloseDay: 17 }];
    w.planPatch = plan => { plan.cardPurchaseCoverage = { rule: 'aggregate-per-card-per-pay-period',
      opening: { asOf: '2026-10-09', confirmed: true, currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] } }; };
  }
  return w;
}
async function badOf(p) {
  return ((await p.rows('[data-operating-question="07"]')).join(' ')
    .match(/Balance After Deductions[^$]*(\$[\d,]+\.\d\d)/) || [])[1] || '';
}
// The Other spending block of the Household budget section, up to the
// reserve note that follows it.
// Forecast on the served document: the same plan and packet the page reads.
function engine(w) {
  const { data, packet, error } = H.dataOf(w);
  H.expect(error == null, 'the observation is applied');
  const view = F.recommend(data.plan, w.asOf, { debts: data.debts, currentPeriodActuals: packet })
    .payPeriodViews.find(r => r.start === '2026-10-09');
  const otherRow = view.householdBudget.find(r => r.id === 'other-spending') || {};
  return { bad: view.balanceAfterDeductions, other: otherRow };
}
// The payday protected path for one world (Prepare Ahead).
function protectedPath(w) {
  const { data, packet } = H.dataOf(w);
  const pp = F.recommend(data.plan, w.asOf, { debts: data.debts, currentPeriodActuals: packet }).paydayAllocation.protectedPath;
  return { wanted: pp.wanted, movable: pp.movable };
}
function pendingWorld(category) {
  const w = world();
  if (category != null) w.transactions.push(H.lm({ date: '2026-10-13', amount: 300, category, account: 'chequing-a',
    payee: 'Invented insurer', pending: true }));
  return w;
}
function other(s) { return (s.household.match(/Other spending.*?(?=Info: protective spending reserve|$)/) || [''])[0]; }

// A case: build the invented world, the hand-derived BAD, the hand-derived
// Other spending figure (null: the row is not household spending), and the
// page assertions.
const cases = [
  {
    name: 'an unplanned Insurance debit on chequing is visible and deducted',
    world() {
      const w = world();
      w.transactions.push(H.lm({ date: '2026-10-12', amount: 240, category: INSURANCE, account: 'chequing-a', payee: 'Invented insurer' }));
      return w;
    },
    bad: 760, other: 240, page: '$760.00',
    async check(s) {
      H.expectMatch(other(s), /Invented insurer/, 'the charge is listed in Other spending');
      H.expectMatch(other(s), /\$240\.00/, 'Other spending shows the 240.00 charge');
    },
  },
  {
    name: 'an unplanned Subscriptions debit on chequing is visible and deducted',
    world() {
      const w = world();
      w.transactions.push(H.lm({ date: '2026-10-12', amount: 15.99, category: SUBSCRIPTIONS, account: 'chequing-b', payee: 'Invented streamer' }));
      return w;
    },
    bad: 984.01, other: 15.99, page: '$984.01',
    async check(s) { H.expectMatch(other(s), /Invented streamer/, 'the charge is listed in Other spending'); },
  },
  {
    name: 'an unplanned Subscriptions charge on the card is visible and deducted',
    world() {
      const w = world(true);
      w.transactions.push(H.lm({ date: '2026-10-12', amount: 15.99, category: SUBSCRIPTIONS, account: 'card-a',
        providerAccountId: 9004, payee: 'Invented streamer' }));
      return w;
    },
    bad: 984.01, other: 15.99, page: '$984.01',
    async check(s) { H.expectMatch(other(s), /Invented streamer/, 'the card charge is listed in Other spending'); },
  },
  {
    name: 'control: a planned Insurance bill paid on its date is the bill, counted once',
    world() {
      const w = world();
      w.bills = [{ id: 'insure', label: 'Invented insurance', amount: 240, frequency: 'monthly', day: 12,
        confidence: 'confirmed', payee: 'Invented insurer' }];
      w.transactions.push(H.lm({ date: '2026-10-12', amount: 240, category: INSURANCE, account: 'chequing-a', payee: 'Invented insurer' }));
      return w;
    },
    // 1,400 - 400 - 240: the bill once, never also as spending.
    bad: 760, other: null, page: '$760.00',
    async check(s) {
      H.expectMatch(H.bill(s, 'Invented insurance'), /Paid/, 'the planned bill shows Paid');
      H.expectExcludes(s.household, 'Invented insurer', 'the bill payment is not also household spending');
    },
  },
  {
    name: 'control: an owner budget exclusion still wins over the bill label',
    world() {
      const w = world();
      w.planPatch = plan => { plan.budget.excluded = [{ from: 'Insurance', label: 'Invented business' }]; };
      w.transactions.push(H.lm({ date: '2026-10-12', amount: 240, category: INSURANCE, account: 'chequing-a', payee: 'Invented insurer' }));
      return w;
    },
    bad: 1000, other: null, page: '$1,000.00',
    async check(s) { H.expectExcludes(s.household, 'Invented insurer', 'an excluded label is not household spending'); },
  },
  {
    name: 'a pending unplanned Insurance debit on chequing is visible and deducted',
    world: () => pendingWorld(INSURANCE),
    bad: 700, other: 300, page: '$700.00',
    async check(s) { H.expectMatch(other(s), /Invented insurer/, 'the pending charge is listed in Other spending'); },
  },
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
      const r = engine(c.world());
      H.expect(Math.abs(r.bad - c.bad) < 0.005, `BAD is ${c.bad} (got ${r.bad})`);
      if (c.other == null) H.expect(!(r.other.spent > 0), `nothing reaches Other spending (got ${r.other.spent})`);
      else {
        H.expect(Math.abs(r.other.spent - c.other) < 0.005, `Other spending is ${c.other} (got ${r.other.spent})`);
        H.expect(r.other.needsConfirmation === true, 'Other spending asks for confirmation');
      }
    });
  }
  await report('engine: a pending unplanned Insurance debit encumbers cash exactly like the same debit labelled Shopping', async () => {
    const ins = protectedPath(pendingWorld(INSURANCE));
    const shop = protectedPath(pendingWorld(SHOPPING));
    const none = protectedPath(pendingWorld(null));
    H.expect(ins.wanted === shop.wanted && ins.movable === shop.movable,
      `protected path agrees with the Shopping control (Insurance ${JSON.stringify(ins)}, Shopping ${JSON.stringify(shop)})`);
    H.expect(ins.movable < none.movable && ins.wanted > none.wanted,
      `the pending debit encumbers cash: less movable than with no debit (${JSON.stringify(ins)} vs ${JSON.stringify(none)})`);
  });
  if (!hasBrowser() || process.env.ATLAS_SKIP_BROWSER === '1') {
    console.log('  SKIP  rendered-page cases: Playwright Chromium is not available here');
  } else {
    for (const c of cases) {
      await report('page: ' + c.name, () => H.withBudget(c.world(), async p => {
        const s = await H.snap(p);
        await c.check(s);
        const bad = await badOf(p);
        H.expect(bad === c.page, `Balance After Deductions shows ${c.page} (got ${bad || 'nothing'})`);
      }));
    }
    await H.closeBrowser();
  }
  console.log(failures ? `\n${failures} failure(s)` : '\nall cases pass');
  process.exit(failures ? 1 : 0);
})();
