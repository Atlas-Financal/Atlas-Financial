'use strict';
// Budget rows read Lunch Money category GROUPS by id (slice 1; Dale's
// decision, #821 6958331123; Grok Bot, Plan #6). A row names its group in
// plan.budget.categories[].lunchMoneyCategoryGroupId; groups that are not
// household spending are plan.budget.excluded[] entries with a kind. A
// category name never routes a row:
//   1  a category inside group G counts on G's row;
//   2  renaming that category changes nothing;
//   3  a new category added to G joins G's row with no config change;
//   4  moving a category from G to H moves its spending to H's row;
//   5  a category outside every group is Other spending, counted, with no
//      hand-confirm (Dale (b));
//   6  one group configured on two rows is never chosen between;
//   7  exclude_from_totals is a transfer and is_income is income, by flag;
//   8  a Business group is not household spending;
//   9  a configured group Lunch Money no longer returns makes its row read
//      Unknown, never an empty $0 (Dale (c)); so does a packet without groups;
//  10  a category NAMED like a row but outside its group does not map;
//  12  the Budget page shows a renamed category's debit on its row;
//  13  a card-payment category inside a card-payment group is never spending,
//      and the same category ungrouped is Other spending (why the group must exist);
//  14  an interest group on a revolving card is interest, not spending;
//  19  a Bills group (kind 'bill') keeps main's finding 4 (3c) (lead ruling,
//      slice 1): (i) a payment in it matching no planned bill is counted once,
//      to confirm, never dropped; (ii) one matching a planned bill on its due
//      day is that bill, not spending; (iii) one near a bill's due date is
//      held on that bill while the bill stays reserved, so it is deducted once.
//
// Invented household (test/acceptance/harness.js) through the real observer
// and Forecast. Expectations are stated per case from the invented inputs.
//
//   Base: plan Groceries 300 + Restaurants 100 (payday targets), asOf Oct 14.
//   Groups: 9100 groceries row, 9200 restaurants row, 9300 business,
//           9400 card payments, 9500 interest.
//
//   node test/test-budget-rows-lm-groups.js
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');

const G_GROC = 9100, G_REST = 9200, G_BIZ = 9300, G_CARD = 9400, G_INT = 9500, G_BILL = 9700;
const near = (a, b) => a != null && b != null && Math.abs(a - b) < 0.005;

function world({ categories, budget, excluded, txs } = {}) {
  const w = H.baseWorld();
  w.explicitGroups = true; // this world lays out its own groups; no fixture layout
  w.categories = categories || [
    { id: G_GROC, name: 'Invented food group', is_group: true },
    { id: G_REST, name: 'Invented eating-out group', is_group: true },
    { id: G_BIZ, name: 'Invented business group', is_group: true },
    { id: G_CARD, name: 'Invented card payments group', is_group: true },
    { id: G_INT, name: 'Invented interest group', is_group: true },
    { id: 201, name: 'Invented supermarket', group_id: G_GROC },
    { id: 202, name: 'Invented takeaway', group_id: G_REST },
    { id: 203, name: 'Invented gifts' },
    { id: 204, name: 'Invented coaching costs', group_id: G_BIZ },
    { id: 205, name: 'Invented card payment', group_id: G_CARD },
    { id: 206, name: 'Invented interest', group_id: G_INT },
    { id: 207, name: 'Invented moved between groups', group_id: G_GROC },
    { id: 208, name: 'Groceries' }, // a row's label as a NAME, outside every group
    { id: 210, name: 'Invented transfer', exclude_from_totals: true },
    { id: 108, name: 'Payroll', is_income: true },
  ];
  w.budget = budget || [
    { id: 'groceries', label: 'Groceries', class: 'essential', plannedPayday: 300, confidence: 'confirmed', lunchMoneyCategoryGroupId: G_GROC },
    { id: 'restaurants', label: 'Restaurants', class: 'discretionary', plannedPayday: 100, confidence: 'confirmed', lunchMoneyCategoryGroupId: G_REST },
  ];
  w.budgetExcluded = excluded || [
    { kind: 'business', lunchMoneyCategoryGroupId: G_BIZ, why: 'Invented pass-through costs' },
    { kind: 'card-payment', lunchMoneyCategoryGroupId: G_CARD, why: 'Invented card payments' },
    { kind: 'interest', lunchMoneyCategoryGroupId: G_INT, why: 'Invented interest' },
  ];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 108, account: 'chequing-a', payee: 'Invented employer' })]
    .concat(txs || []);
  return w;
}
const spend = (category, amount, extra = {}) => H.lm({ date: '2026-10-11', amount, category, account: 'chequing-b',
  payee: 'Invented shop ' + category, ...extra });

function engine(w) {
  const { data, packet, error } = H.dataOf(w);
  H.expect(error == null, 'the observation is applied');
  const view = F.recommend(data.plan, w.asOf, { debts: data.debts, currentPeriodActuals: packet })
    .payPeriodViews.find(r => r.start === '2026-10-09');
  const rows = view.householdBudget || [];
  const row = id => rows.find(r => r.id === id) || null;
  const txs = ((packet && packet.transactions) || []).filter(t => t.date === '2026-10-11');
  const cls = txs.map(t => F.classifyCurrentPeriodTransaction(t, data.plan, { packet, currentPeriodActuals: packet }));
  return { view, row, txs, cls, bad: view.balanceAfterDeductions, packet, plan: data.plan };
}
const toConfirm = r => r.cls.filter(c => c && c.needsConfirmation).length;

function hasBrowser() {
  if (process.env.CHROME_PATH) return true;
  try { require.resolve('playwright'); return true; } catch { return false; }
}

(async () => {
  let failures = 0;
  const report = (name, fn) => Promise.resolve().then(fn).then(() => console.log('  PASS  ' + name),
    err => { failures++; console.log('  FAIL  ' + name + ' -- ' + String(err && err.message || err).split('\n')[0]); });

  await report('observer: categoryGroupId is stamped from the group, and the packet lists the groups returned', () => {
    const r = engine(world({ txs: [spend(201, 40)] }));
    H.expect(r.txs.length === 1 && String(r.txs[0].categoryGroupId) === String(G_GROC),
      `the row carries its group (got ${JSON.stringify(r.txs.map(t => t.categoryGroupId))})`);
    H.expect(Array.isArray(r.packet.categoryGroupIds) && [G_GROC, G_REST, G_BIZ, G_CARD, G_INT].every(id => r.packet.categoryGroupIds.includes(String(id))),
      `group ids listed (got ${JSON.stringify(r.packet.categoryGroupIds)})`);
  });
  await report('1: a category inside the groceries group counts 40.00 on Groceries', () => {
    const r = engine(world({ txs: [spend(201, 40)] }));
    H.expect(near(r.row('groceries').spent, 40), `Groceries spent 40 (got ${r.row('groceries').spent})`);
    H.expect(toConfirm(r) === 0, 'nothing to confirm');
  });
  await report('2: renaming that category in Lunch Money changes nothing', () => {
    const w = world({ txs: [spend(201, 40)] });
    w.categories.find(c => c.id === 201).name = 'Invented renamed supermarket';
    const r = engine(w);
    H.expect(near(r.row('groceries').spent, 40), `Groceries spent 40 (got ${r.row('groceries').spent})`);
    H.expect(toConfirm(r) === 0, 'nothing to confirm');
  });
  await report('3: a new category added to the groceries group joins Groceries with no config change', () => {
    const w = world({ txs: [spend(220, 25)] });
    w.categories.push({ id: 220, name: 'Invented new bulk store', group_id: G_GROC });
    const r = engine(w);
    H.expect(near(r.row('groceries').spent, 25), `Groceries spent 25 (got ${r.row('groceries').spent})`);
  });
  await report('4: moving a category from the groceries group to the eating-out group moves its spending', () => {
    const before = engine(world({ txs: [spend(207, 30)] }));
    const w = world({ txs: [spend(207, 30)] });
    w.categories.find(c => c.id === 207).group_id = G_REST;
    const after = engine(w);
    H.expect(near(before.row('groceries').spent, 30) && near(before.row('restaurants').spent, 0),
      `before: Groceries 30, Restaurants 0 (got ${before.row('groceries').spent}, ${before.row('restaurants').spent})`);
    H.expect(near(after.row('groceries').spent, 0) && near(after.row('restaurants').spent, 30),
      `after: Groceries 0, Restaurants 30 (got ${after.row('groceries').spent}, ${after.row('restaurants').spent})`);
  });
  await report('5: a category outside every group is Other spending, counted once, with no hand-confirm', () => {
    const none = engine(world());
    const r = engine(world({ txs: [spend(203, 17.5)] }));
    H.expect(r.cls.length === 1 && r.cls[0].kind === 'spend' && r.cls[0].categoryId === 'uncategorised'
      && r.cls[0].needsConfirmation === false && r.cls[0].includeReason === 'ungrouped-category',
      `Other spending, not to confirm (got ${JSON.stringify(r.cls[0])})`);
    H.expect(near(none.bad - r.bad, 17.5), `balance after deductions drops 17.50 once (${none.bad} -> ${r.bad})`);
  });
  await report('6: one group configured on two rows is never chosen between', () => {
    const w = world({ txs: [spend(201, 40)] });
    w.budget[1].lunchMoneyCategoryGroupId = G_GROC;
    const r = engine(w);
    H.expect(r.cls[0].needsConfirmation === true && r.cls[0].reason === 'ambiguous-category',
      `ambiguous, to confirm (got ${JSON.stringify(r.cls[0])})`);
  });
  await report('7: exclude_from_totals is a transfer and is_income is income, by flag, with no label list', () => {
    const r = engine(world({ txs: [spend(210, 500)] }));
    H.expect(r.cls[0].kind === 'transfer', `transfer (got ${JSON.stringify(r.cls[0])})`);
    const inc = F.classifyCurrentPeriodTransaction({ date: '2026-10-11', amount: -50, isIncome: true, categoryId: '108',
      categoryLabel: 'Invented any name', accountRole: 'household-cash', atlasAccountId: 'chequing-a' }, r.plan, {});
    H.expect(inc.kind === 'income' || inc.householdSpending === false, `income is never spending (got ${JSON.stringify(inc)})`);
  });
  await report('8: a debit in the Business group is not household spending', () => {
    const none = engine(world());
    const r = engine(world({ txs: [spend(204, 60)] }));
    H.expect(r.cls[0].kind === 'business' && r.cls[0].householdSpending === false, `business (got ${JSON.stringify(r.cls[0])})`);
    H.expect(near(none.bad, r.bad), `balance after deductions unchanged (${none.bad} -> ${r.bad})`);
  });
  await report('9: a configured group Lunch Money no longer returns makes its row Unknown, never $0', () => {
    const w = world({ txs: [spend(202, 12)] });
    w.categories = w.categories.filter(c => c.id !== G_GROC && c.group_id !== G_GROC);
    const r = engine(w);
    H.expect(r.row('groceries') && r.row('groceries').spent === null, `Groceries spent Unknown (got ${r.row('groceries') && r.row('groceries').spent})`);
    H.expect(near(r.row('restaurants').spent, 12), `Restaurants still counts 12 (got ${r.row('restaurants').spent})`);
    const noGroups = engine(world({ txs: [spend(201, 40)] }));
    delete noGroups.packet.categoryGroupIds;
    const view = F.recommend(noGroups.plan, '2026-10-14', { currentPeriodActuals: noGroups.packet })
      .payPeriodViews.find(p => p.start === '2026-10-09');
    const groc = (view.householdBudget || []).find(x => x.id === 'groceries');
    H.expect(groc && groc.spent === null, `a packet without groups proves nothing: Unknown (got ${groc && groc.spent})`);
  });
  await report('10: a category NAMED "Groceries" outside the group does not map to Groceries', () => {
    const r = engine(world({ txs: [spend(208, 22)] }));
    H.expect(near(r.row('groceries').spent, 0), `Groceries spent 0 (got ${r.row('groceries').spent})`);
    H.expect(r.cls[0].categoryId === 'uncategorised' && r.cls[0].includeReason === 'ungrouped-category',
      `Other spending (got ${JSON.stringify(r.cls[0])})`);
  });
  // Lead ruling (slice 1): Dale's (b) is about SPENDING categories. A row in the
  // category Lunch Money itself marks as a transfer (exclude_from_totals) is a
  // transfer even when that category sits in no group: never Other spending, and
  // its payee stays stripped from the served packet. Not decided by any name.
  await report('15: a real-shaped transfer category in no group stays a transfer, payee stripped, never Other spending', () => {
    const none = engine(world());
    const r = engine(world({ txs: [spend(210, 500, { payee: 'Invented transfer payee' })] }));
    H.expect(r.cls[0].kind === 'transfer' && r.cls[0].householdSpending === false,
      `transfer (got ${JSON.stringify(r.cls[0])})`);
    H.expect(!r.txs[0].displayedPayee && !r.txs[0].originalMerchant,
      `payee stripped (got ${JSON.stringify({ p: r.txs[0].displayedPayee, o: r.txs[0].originalMerchant })})`);
    H.expect(near(none.bad, r.bad), `balance after deductions unchanged (${none.bad} -> ${r.bad})`);
    const renamed = world({ txs: [spend(210, 500)] });
    renamed.categories.find(c => c.id === 210).name = 'Invented name that is not transfer';
    H.expect(engine(renamed).cls[0].kind === 'transfer', 'renaming the transfer category changes nothing');
  });
  await report('17: privacy: a group the plan does not name never leaves the observer (published null, ungrouped)', () => {
    const w = world({ txs: [spend(230, 8)] });
    w.categories.push({ id: 9900, name: 'Invented unconfigured group', is_group: true },
      { id: 230, name: 'Invented elsewhere', group_id: 9900 });
    const r = engine(w);
    H.expect(r.txs[0].categoryGroupId === null, `published null (got ${r.txs[0].categoryGroupId})`);
    H.expect(!JSON.stringify(r.packet).includes('9900'), 'the unconfigured group id appears nowhere in the packet');
    H.expect(r.cls[0].includeReason === 'ungrouped-category', `read as ungrouped (got ${JSON.stringify(r.cls[0])})`);
  });
  // Grok Bot ("partly"; lead ruling): every category in the Fuel & transport
  // group counts on the Fuel row, but only the Fuel category itself, by its id
  // on the fuel row (lunchMoneyFuelCategoryId), is fuel evidence for the
  // convenience-store gate. Not the group, not a name.
  await report('18: only the Fuel category id is fuel evidence; another category in the Fuel group is not', () => {
    const plan = { budget: { categories: [
      { id: 'fuel', label: 'Fuel', class: 'essential', plannedPayday: 100, confidence: 'confirmed',
        lunchMoneyCategoryGroupId: 9600, lunchMoneyFuelCategoryId: 240 }] } };
    const row = (categoryId, name) => ({ date: '2026-10-11', amount: 40, categoryId, categoryGroupId: '9600', categoryLabel: name,
      accountRole: 'household-cash', atlasAccountId: 'chequing-b', displayedPayee: '7-ELEVEN 4451', originalMerchant: '7-ELEVEN 4451' });
    const fuel = F.classifyCurrentPeriodTransaction(row('240', 'Invented any name'), plan, {});
    H.expect(fuel.kind === 'spend' && fuel.categoryId === 'fuel' && fuel.needsConfirmation === false,
      `the Fuel category at a convenience store is Fuel (got ${JSON.stringify(fuel)})`);
    const parking = F.classifyCurrentPeriodTransaction(row('241', 'Fuel'), plan, {});
    H.expect(parking.needsConfirmation === true && parking.reason === 'convenience-store-unconfirmed-fuel',
      `another category in the Fuel group, even one NAMED "Fuel", is not evidence (got ${JSON.stringify(parking)})`);
  });
  await report('16: a row with no Lunch Money category id fails closed to confirmation, never Other spending', () => {
    const blank = engine(world({ txs: [H.lm({ date: '2026-10-11', amount: 14, account: 'chequing-b', payee: 'Invented blank' })] }));
    H.expect(blank.cls[0].needsConfirmation === true && blank.cls[0].includeReason === 'no-category',
      `no category: to confirm (got ${JSON.stringify(blank.cls[0])})`);
    const plan = engine(world()).plan;
    const nameOnly = F.classifyCurrentPeriodTransaction({ date: '2026-10-11', amount: 14, categoryLabel: 'Invented supermarket',
      accountRole: 'household-cash', atlasAccountId: 'chequing-b', displayedPayee: 'Invented shop' }, plan, {});
    H.expect(nameOnly.needsConfirmation === true && nameOnly.includeReason === 'unmapped-label',
      `a name with no category id: to confirm (got ${JSON.stringify(nameOnly)})`);
  });
  await report('13: a card-payment category in its group is never spending; the same category ungrouped is Other spending', () => {
    const none = engine(world());
    const grouped = engine(world({ txs: [spend(205, 300)] }));
    H.expect(grouped.cls[0].kind === 'transfer' && grouped.cls[0].householdSpending === false,
      `transfer (got ${JSON.stringify(grouped.cls[0])})`);
    H.expect(near(none.bad, grouped.bad), `balance after deductions unchanged (${none.bad} -> ${grouped.bad})`);
    const w = world({ txs: [spend(205, 300)] });
    delete w.categories.find(c => c.id === 205).group_id;
    const ungrouped = engine(w);
    H.expect(ungrouped.cls[0].householdSpending === true && ungrouped.cls[0].categoryId === 'uncategorised',
      `ungrouped, it is counted (got ${JSON.stringify(ungrouped.cls[0])})`);
  });
  await report('14: an interest group on a revolving card is interest, not spending', () => {
    const plan = engine(world()).plan;
    const row = { date: '2026-10-11', amount: 9.99, categoryId: '206', categoryLabel: 'Invented interest',
      accountRole: 'revolving-credit', atlasAccountId: 'cashback', displayedPayee: 'Invented issuer' };
    const c = F.classifyCurrentPeriodTransaction({ ...row, categoryGroupId: String(G_INT) }, plan, {});
    const control = F.classifyCurrentPeriodTransaction(row, plan, {});
    H.expect(control.kind !== 'interest', `control: the same row with no group is not interest by its name (got ${JSON.stringify(control)})`);
    H.expect(c.kind === 'interest' && c.householdSpending === false, `interest (got ${JSON.stringify(c)})`);
  });
  // Bills group (lead ruling, slice 1; main's finding 4, 3c). Invented bill:
  // phone 60.00 monthly, due Oct 11, paid from chequing-a by payee identity.
  const PHONE = { id: 'phone', label: 'Invented phone', amount: 60, frequency: 'monthly', day: 11,
    confidence: 'confirmed', payee: 'Invented phone co' };
  const billsWorld = (txs, bills) => {
    const w = world({ txs });
    w.categories.push({ id: G_BILL, name: 'Invented bills group', is_group: true },
      { id: 209, name: 'Invented phone bill', group_id: G_BILL });
    w.budgetExcluded.push({ kind: 'bill', lunchMoneyCategoryGroupId: G_BILL, why: 'Invented bills' });
    w.bills = bills || [{ ...PHONE }];
    return w;
  };
  const billPay = (date, amount, payee) => H.lm({ date, amount, category: 209, account: 'chequing-a', payee });
  const billOf = (r, id) => ((r.view.bills) || []).find(b => b && b.id === id) || null;
  const clsAt = (r, date, amount) => {
    const tx = ((r.packet && r.packet.transactions) || []).find(t => t.date === date && near(Math.abs(Number(t.amount)), amount));
    return tx ? F.classifyCurrentPeriodTransaction(tx, r.plan, { packet: r.packet, currentPeriodActuals: r.packet }) : null;
  };
  await report('19(i): a Bills-group payment matching no planned bill is counted once, to confirm, never dropped', () => {
    const none = engine(billsWorld([]));
    const r = engine(billsWorld([billPay('2026-10-11', 45, 'Invented unknown biller')]));
    const c = clsAt(r, '2026-10-11', 45);
    H.expect(c && c.householdSpending === true && c.needsConfirmation === true && c.reason === 'unmapped-label',
      `counted, to confirm (got ${JSON.stringify(c)})`);
    H.expect(near(none.bad - r.bad, 45), `balance after deductions drops 45.00 once (${none.bad} -> ${r.bad})`);
  });
  await report('19(ii): a Bills-group payment matching the planned bill on its due day is that bill, not spending', () => {
    const r = engine(billsWorld([billPay('2026-10-11', 60, 'Invented phone co')]));
    const c = clsAt(r, '2026-10-11', 60);
    H.expect(c && c.kind === 'bill' && c.householdSpending === false && c.reason === 'represented-bill',
      `the planned bill (got ${JSON.stringify(c)})`);
    H.expect((r.packet.representedActuals || []).some(a => a && a.id === 'phone'), 'the payment represents the phone bill');
  });
  await report('19(iii): a Bills-group payment near the bill\'s due date is held on the bill, deducted once', () => {
    const none = engine(billsWorld([]));
    const r = engine(billsWorld([billPay('2026-10-13', 60, 'Invented phone co')]));
    const c = clsAt(r, '2026-10-13', 60);
    H.expect(c && c.householdSpending === false && c.reason === 'near-due-bill-unconfirmed',
      `held on the bill, not spending (got ${JSON.stringify(c)})`);
    const b = billOf(r, 'phone');
    H.expect(b && b.status !== 'PAID' && near(b.remaining, 60), `the bill stays reserved (got ${b && b.status}/${b && b.remaining})`);
    H.expect(near(none.bad, r.bad), `balance after deductions unchanged: the reserve alone deducts it (${none.bad} -> ${r.bad})`);
  });
  await report('mutation guard: a name equal to a row label never routes (classifier, no group)', () => {
    const plan = engine(world()).plan;
    const c = F.classifyCurrentPeriodTransaction({ date: '2026-10-11', amount: 5, categoryId: '999', categoryLabel: 'Groceries',
      accountRole: 'household-cash', atlasAccountId: 'chequing-b', displayedPayee: 'Invented shop' }, plan, {});
    H.expect(c.categoryId === 'uncategorised' && c.includeReason === 'ungrouped-category', `not Groceries (got ${JSON.stringify(c)})`);
  });

  await report('the fixture-only name baseline never reaches production: nothing in public/ or scripts/ requires it', () => {
    const fs = require('fs'), path = require('path');
    const root = path.join(__dirname, '..');
    const offenders = [];
    const walk = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
        else if (/\.(c|m)?js$/.test(e.name) && /lm-groups-fixture|preGroupRouteBaseline/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(root, p));
      }
    };
    walk(path.join(root, 'public'));
    walk(path.join(root, 'scripts'));
    H.expect(offenders.length === 0, `no production file names the fixture baseline (got ${offenders.join(', ')})`);
  });

  if (!hasBrowser() || process.env.ATLAS_SKIP_BROWSER === '1') {
    console.log('  SKIP  rendered-page case: Playwright Chromium is not available here');
  } else {
    await report('12: page: a renamed category\'s debit shows under Groceries, with no To confirm line', async () => {
      const w = world({ txs: [spend(201, 40, { payee: 'Invented renamed shop' })] });
      w.categories.find(c => c.id === 201).name = 'Invented renamed supermarket';
      await H.withBudget(w, async p => {
        const s = await H.snap(p);
        H.expectMatch(H.category(s, 'Groceries'), /\$40\.00/, 'Groceries shows 40.00');
        H.expect(H.occurrences(s.household, 'Invented renamed shop') === 1, 'the debit is listed once (under Groceries)');
        H.expectExcludes(H.category(s, 'Groceries'), 'To confirm', 'Groceries has nothing to confirm');
      });
    });
    await H.closeBrowser();
  }
  console.log(failures ? `\n${failures} failure(s)` : '\nall cases pass');
  process.exit(failures ? 1 : 0);
})();
