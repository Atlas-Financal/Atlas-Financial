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
//   Mortgage is kept out of household spending while the plan has a planned
//   mortgage payment: that cash is the secured-debt payment the debt walk
//   already deducts, so a "Mortgage" row counted again would deduct it twice
//   (engine guard below; test-household-budget-other-spending.js covers the
//   waterfall). With no planned mortgage payment in the debit's cycle it is
//   a loan payment no owner claims: held To confirm, never household
//   spending, and deducted once from BAD as its own term (rank 18, lead
//   ruling under OD-021; previously Other spending, finish-line audit 4).
//   7. Atlas #922: the same 240.00 debit when the plan has a bills-only
//      Insurance / Subscriptions / Telecom budget category the label maps
//      to, posted and pending: BAD 760.00, listed in Other; pending
//      encumbers like Shopping.
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
  return { bad: view.balanceAfterDeductions, other: otherRow, held: view.heldOutflowsToConfirm || null,
    terms: view.predictedEndingBalanceTerms || null };
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
// Atlas #922 finding 1: the plan carries a bills-only budget category
// (insurance / subscriptions / telecom) with no target and no planned bill,
// and the provider label maps to it. That mapping alone is not a planned
// bill either.
const BILLS_ONLY = [['insurance', 'Insurance', INSURANCE], ['subscriptions', 'Subscriptions', SUBSCRIPTIONS], ['telecom', 'Telecom', 115]];
function mappedWorld(id, name, catId, pending) {
  const w = world();
  if (!w.categories.some(c => c.id === catId)) w.categories.push({ id: catId, name });
  w.budget.push({ id, label: name, class: 'essential', confidence: 'confirmed', from: [name] });
  w.transactions.push(H.lm({ date: pending ? '2026-10-13' : '2026-10-12', amount: 240, category: catId,
    account: 'chequing-a', payee: 'Invented ' + id + ' co', pending: pending === true }));
  return w;
}
const MORTGAGE = 116;
function mortgageWorld(day) {
  const w = world();
  w.categories.push({ id: MORTGAGE, name: 'Mortgage' });
  w.planPatch = plan => { plan.obligations = (plan.obligations || []).concat([{ id: 'mortgage', debtId: 'mortgage',
    effect: 'payment', label: 'Invented mortgage', frequency: 'monthly', day, amount: 400, confidence: 'confirmed' }]); };
  w.transactions.push(H.lm({ date: '2026-10-12', amount: 400, category: MORTGAGE, account: 'chequing-a', payee: 'Invented lender' }));
  return w;
}
// Grok Bot (Plan #6 thread) on a mortgage payment that posts after its due
// date's cycle: the mortgage is due Oct 22 (cycle Oct 9 - Oct 22) and the
// Mortgage-labelled debit posts Oct 23 (cycle Oct 23 - Nov 5), as-of Oct 24.
// No date matching: the debit is held To confirm (rank 18: never household
// spending), with a neutral line naming the earlier mortgage still To confirm. Paid Oct 23 from
// chequing-a, so the observed Bills account reads 2,000 - 400 = 1,600.
function lateMortgageWorld({ debit = true, ownerMarked = false } = {}) {
  const w = H.baseWorld('2026-10-24');
  w.categories.push({ id: MORTGAGE, name: 'Mortgage' });
  w.transactions = [H.lm({ date: '2026-10-23', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  if (debit) {
    w.transactions.push(H.lm({ date: '2026-10-23', amount: 400, category: MORTGAGE, account: 'chequing-a', payee: 'Invented lender' }));
    w.accounts.find(a => a.id === 'chequing-a').value -= 400;
  }
  w.planPatch = plan => {
    plan.obligations = (plan.obligations || []).concat([{ id: 'mortgage', debtId: 'mortgage', effect: 'payment',
      label: 'Invented mortgage', frequency: 'monthly', day: 22, amount: 400, confidence: 'confirmed', payingAccount: 'chequing-a' }]);
    if (ownerMarked) plan.opening.representedEvents = (plan.opening.representedEvents || []).concat([{ id: 'mortgage', date: '2026-10-22' }]);
  };
  return w;
}
function lateEngine(w) {
  const { data, packet, error } = H.dataOf(w);
  H.expect(error == null, 'the observation is applied');
  const advice = F.recommend(data.plan, '2026-10-24', { debts: data.debts, currentPeriodActuals: packet });
  const view = advice.payPeriodViews.find(r => r.start === '2026-10-23');
  const otherRow = view.householdBudget.find(r => r.id === 'other-spending') || {};
  const held = view.heldOutflowsToConfirm || null;
  return { advice, bad: view.balanceAfterDeductions, other: otherRow, held, terms: view.predictedEndingBalanceTerms || null,
    lender: ((held && held.recon) || []).find(t => t.displayedPayee === 'Invented lender') };
}
function other(s) { return (s.household.match(/Other spending.*?(?=To confirm|Info: protective spending reserve|$)/) || [''])[0]; }
// The To confirm block (rank 18): held outflows, never spending.
function toConfirm(s) { return (s.household.match(/To confirm.*?(?=Paid from Savings|Info: protective spending reserve|$)/) || [''])[0]; }

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
  {
    name: 'control: a planned bill in a bills-only Insurance category paid on its date is the bill, counted once',
    world() {
      const w = mappedWorld('insurance', 'Insurance', INSURANCE, false);
      w.bills = [{ id: 'insure', label: 'Invented insurance', amount: 240, frequency: 'monthly', day: 12,
        confidence: 'confirmed', payee: 'Invented insurance co', budgetCategory: 'insurance' }];
      return w;
    },
    bad: 760, other: null, page: '$760.00',
    async check(s) {
      H.expectMatch(H.bill(s, 'Invented insurance'), /Paid/, 'the planned bill shows Paid');
      H.expectExcludes(s.household, 'Invented insurance co', 'the bill payment is not also household spending');
    },
  },
  // #1071 follow-up (lead ruling): the Mortgage exclusion holds only when
  // the planned mortgage payment has an occurrence in the debit's own
  // spending cycle (Oct 9 - Oct 22 here).
  {
    name: 'a Mortgage debit in a cycle where the planned mortgage falls due only in another cycle is held To confirm and deducted once',
    world: () => mortgageWorld(25),
    // Oct 25 is in the next cycle: no mortgage bill here. It is held, not
    // spending: Other 0, the held term 400, BAD 1,400 - 400 - 0 - 400 = 600.
    bad: 600, other: null, held: 400, page: '$600.00',
    async check(s) {
      H.expectMatch(toConfirm(s), /Invented lender/, 'the debit is listed under To confirm');
      H.expectExcludes(other(s), 'Invented lender', 'the debit is not in Other spending');
    },
  },
  {
    name: 'control: a Mortgage debit in the cycle of a planned mortgage occurrence is the mortgage, counted once',
    world: () => mortgageWorld(12),
    // The Oct 12 mortgage occurrence is the cycle's bill: 1,000 - 400, never
    // also as spending.
    bad: 600, other: null, page: '$600.00',
    async check(s) { H.expectExcludes(s.household, 'Invented lender', 'the mortgage debit is not also household spending'); },
  },
  ...BILLS_ONLY.flatMap(([id, name, catId]) => [false, true].map(pending => ({
    name: `a${pending ? ' pending' : 'n'} unplanned debit mapped to the bills-only ${name} budget category is visible and deducted`,
    world: () => mappedWorld(id, name, catId, pending),
    // 1,000 - 240, posted or pending alike.
    bad: 760, other: 240, page: '$760.00',
    async check(s) { H.expectMatch(other(s), new RegExp('Invented ' + id + ' co'), 'the charge is listed in Other spending'); },
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
      const r = engine(c.world());
      H.expect(Math.abs(r.bad - c.bad) < 0.005, `BAD is ${c.bad} (got ${r.bad})`);
      if (c.other == null) H.expect(!(r.other.spent > 0), `nothing reaches Other spending (got ${r.other.spent})`);
      else {
        H.expect(Math.abs(r.other.spent - c.other) < 0.005, `Other spending is ${c.other} (got ${r.other.spent})`);
        H.expect(r.other.needsConfirmation === true, 'Other spending asks for confirmation');
      }
      if (c.held == null) H.expect(!r.held && !(r.terms && r.terms.heldOutflowSpending), 'nothing is held To confirm');
      else {
        H.expect(r.held && Math.abs(r.held.total - c.held) < 0.005, `To confirm holds ${c.held} (got ${r.held && r.held.total})`);
        H.expect(r.terms && Math.abs(r.terms.heldOutflowSpending - c.held) < 0.005 && r.terms.closes === true,
          `BAD terms deduct ${c.held} once and close (got ${JSON.stringify(r.terms)})`);
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
  // Finish-line audit finding 4 (3a, lead ruling on #821): the Mortgage guard
  // holds only while the plan has a planned mortgage payment for the debt
  // walk to deduct. With none, the row is Other spending, counted.
  const mortgageTx = { id: 'tx-mortgage', date: '2026-10-12', amount: 1600,
    categoryLabel: 'Mortgage', accountRole: 'household-cash', atlasAccountId: 'chequing-a' };
  await report('engine: a Mortgage-labelled payment under a planned mortgage payment stays out of household spending (no double deduction)', async () => {
    const plan = H.planOf(world());
    plan.obligations = (plan.obligations || []).concat([{ id: 'mortgage', debtId: 'mortgage', effect: 'payment',
      label: 'Mortgage', frequency: 'monthly', day: 12, amount: 1600, confidence: 'confirmed' }]);
    const cls = F.classifyCurrentPeriodTransaction(mortgageTx, plan);
    H.expect(cls.householdSpending === false && cls.kind === 'bill', `Mortgage is not household spending (got ${JSON.stringify(cls)})`);
  });
  // #1071 follow-up: a planned mortgage payment with no occurrence in the
  // debit's own cycle (Oct 9 - Oct 22) does not exclude the row, whether the
  // payment is monthly in another cycle, a one-off in another cycle, or the
  // debit has no readable date.
  for (const [what, row, tx] of [
    ['monthly, due only in the next cycle', { frequency: 'monthly', day: 25 }, mortgageTx],
    ['one-off, due in the previous cycle', { frequency: 'once', date: '2026-10-05' }, mortgageTx],
    ['one-off, due in the next cycle', { frequency: 'once', date: '2026-10-23' }, mortgageTx],
    ['monthly in the cycle, but the debit has no date', { frequency: 'monthly', day: 12 }, { ...mortgageTx, date: undefined }],
  ]) {
    await report(`engine: a Mortgage-labelled payment whose planned mortgage is ${what} is held To confirm, not spending`, async () => {
      const plan = H.planOf(world());
      plan.obligations = (plan.obligations || []).concat([{ id: 'mortgage', debtId: 'mortgage', effect: 'payment',
        label: 'Mortgage', amount: 1600, confidence: 'confirmed', ...row }]);
      const cls = F.classifyCurrentPeriodTransaction(tx, plan);
      H.expect(cls.kind === 'held-outflow' && cls.householdSpending === false && cls.needsConfirmation === true,
        `the Mortgage row is held To confirm, never household spending (got ${JSON.stringify(cls)})`);
    });
  }
  await report('engine: a Mortgage-labelled payment with no planned mortgage payment is held To confirm, not spending', async () => {
    const cls = F.classifyCurrentPeriodTransaction(mortgageTx, H.planOf(world()));
    H.expect(cls.kind === 'held-outflow' && cls.householdSpending === false && cls.needsConfirmation === true,
      `an unplanned Mortgage row is held To confirm, never household spending (got ${JSON.stringify(cls)})`);
  });
  await report('engine: a Mortgage debit posted after its due date\'s cycle is held To confirm, naming the mortgage still To confirm', async () => {
    const r = lateEngine(lateMortgageWorld());
    // 1,400 - 400 (budget) - 400 (the held debit, its own term, once) = 600.
    H.expect(Math.abs(r.bad - 600) < 0.005, `BAD is 600 (got ${r.bad})`);
    H.expect(!(r.other.spent > 0), `nothing reaches Other spending (got ${r.other.spent})`);
    H.expect(r.held && Math.abs(r.held.total - 400) < 0.005, `To confirm holds 400 (got ${r.held && r.held.total})`);
    H.expect(r.terms && r.terms.heldOutflowSpending === 400 && r.terms.closes === true, `BAD terms deduct it once (got ${JSON.stringify(r.terms)})`);
    H.expect(r.lender && r.lender.mortgageDueToConfirm === '2026-10-22', `the row names the Oct 22 mortgage (got ${JSON.stringify(r.lender)})`);
  });
  await report('engine: control: with the Oct 22 mortgage marked paid by the owner, the row carries no mortgage line', async () => {
    const r = lateEngine(lateMortgageWorld({ ownerMarked: true }));
    H.expect(r.lender && r.lender.mortgageDueToConfirm === undefined, `no line (got ${JSON.stringify(r.lender)})`);
  });
  // KNOWN LIMITATION, recorded not fixed (BACKLOG, routed to Grok Bot): the
  // master cash walk still deducts the unconfirmed Oct 22 mortgage occurrence
  // at its start, although the Oct 23 Mortgage debit is already out of the
  // observed 1,600. This is the same on main, whatever the debit's category.
  // Atlas does not link the debit to Oct 22 (that would be date matching,
  // which Grok ruled out); confirming the Oct 22 payment in the ledger
  // (a linked represented actual) clears it. This check pins the behaviour so
  // a change to it is seen.
  await report('engine: known limitation: the cash walk still deducts the unconfirmed Oct 22 mortgage beside the late debit', async () => {
    const walk = w => {
      const { data, packet } = H.dataOf(w);
      return F.simulate(data.plan, '2026-10-24', { debts: data.debts, currentPeriodActuals: packet, weeklyVariable: 0 });
    };
    const paid = walk(lateMortgageWorld()), none = walk(lateMortgageWorld({ debit: false }));
    for (const s of [paid, none]) {
      H.expect((s.events || []).some(e => /mortgage/.test(e.id || '') && e.date === '2026-10-22'),
        'the walk deducts the unconfirmed Oct 22 occurrence in both worlds');
    }
    // The debit is out of the opening (1,600 vs 2,000); both walks also deduct
    // Oct 22, so the endings differ by exactly the 400 opening difference.
    H.expect(Math.round((none.ending - paid.ending) * 100) === 40000,
      `ending differs by exactly 400 (${none.ending} vs ${paid.ending})`);
  });
  for (const [id, name, catId] of BILLS_ONLY) {
    await report(`engine: a pending debit mapped to bills-only ${name} encumbers cash like the same debit labelled Shopping`, async () => {
      const mapped = protectedPath(mappedWorld(id, name, catId, true));
      const shopW = mappedWorld(id, name, catId, true);
      shopW.transactions[shopW.transactions.length - 1].category_id = SHOPPING;
      const shop = protectedPath(shopW);
      H.expect(mapped.wanted === shop.wanted && mapped.movable === shop.movable,
        `protected path agrees with the Shopping control (${name} ${JSON.stringify(mapped)}, Shopping ${JSON.stringify(shop)})`);
    });
  }
  if (!hasBrowser() || process.env.ATLAS_SKIP_BROWSER === '1') {
    console.log('  SKIP  rendered-page cases: Playwright Chromium is not available here');
  } else {
    await report('page: the late Mortgage debit prints the neutral mortgage line under To confirm', () => H.withBudget(lateMortgageWorld(), async p => {
      const s = await H.snap(p);
      H.expectMatch(toConfirm(s), /Invented lender/, 'the debit is listed under To confirm');
      H.expectExcludes(other(s), 'Invented lender', 'the debit is not in Other spending');
      H.expectMatch(toConfirm(s), /Mortgage-labelled; the mortgage due Oct 22 is still To confirm/, 'the neutral line names the Oct 22 mortgage');
    }));
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
