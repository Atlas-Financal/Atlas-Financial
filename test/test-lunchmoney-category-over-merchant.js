'use strict';
/* H1 — Lunch Money owns purchase categories; a merchant rule never
 * overrides an explicit Lunch Money category.
 *
 * Two owner directions disagreed: 2026-09-02/03 merchant identities (one
 * merchant is Fuel; one is Dog food; named merchants are Groceries or a
 * person's guilt-free spending) and the
 * 2026-10-14 rule that Lunch Money owns categories and a Fast Food or
 * Shopping purchase must not become Fuel because of its merchant. The
 * lead decided (owner standing rule) that the newer rule wins: the
 * merchant rules apply only to rows Lunch Money left uncategorised.
 *
 * Shape: the served current-period packet. The observer stamps the
 * merchant rules as flags (confirmedFuel, dogFood) before publication;
 * ownerConfirmedFuel is the separate exact owner-confirmed transaction
 * evidence. Merchants are invented; no real merchant name appears here.
 *
 * Proof: parity. For an explicit category, the classification with the
 * merchant flag equals the classification of the same row without it.
 *
 * `node test/test-lunchmoney-category-over-merchant.js`
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const plan = { budget: { categories: [
  { id: 'groceries', label: 'Groceries', from: ['Groceries'], plannedPayday: 100 },
  { id: 'fuel', label: 'Fuel', from: ['Fuel'], plannedPayday: 100 },
  { id: 'pets', label: 'Dog food', from: ['Pets'], plannedMonthly: 50 },
  { id: 'restaurants', label: 'Eating out', from: ['Restaurants', 'Fast Food'], plannedPayday: 100 },
] } };

function packetTx(categoryLabel, flags, over) {
  return Object.assign({
    id: 'h1-' + Math.random().toString(36).slice(2), date: '2031-05-06', amount: 42.17, pending: false,
    categoryLabel, displayedPayee: 'Invented Corner Store', originalMerchant: 'Invented Corner Store',
    currency: 'cad', accountRole: 'household-cash', atlasAccountId: 'chequing-b', account: 'chequing-b',
    kindHint: null, isIncome: false, excludeFromTotals: false, merchantKnown: true,
    dogFood: false, convenienceStore: false, canadianTire: false, groceryUncertain: false,
    groceryMixed: false, fuelEvidence: false, confirmedGrocery: false,
    confirmedFuel: false, ownerConfirmedFuel: false,
  }, flags || {}, over || {});
}
const classify = tx => F.classifyCurrentPeriodTransaction(tx, plan, {});
const shape = cls => JSON.stringify({ kind: cls.kind, categoryId: cls.categoryId, needs: cls.needsConfirmation === true });

console.log('=== 1. explicit Lunch Money categories are not turned into Fuel by merchant ===');
for (const label of ['Fast Food', 'Restaurants', 'Groceries', 'Shopping', 'Pets']) {
  const withRule = classify(packetTx(label, { confirmedFuel: true }));
  const without = classify(packetTx(label));
  ok(withRule.categoryId !== 'fuel', `${label}: the confirmed-fuel merchant does not make it Fuel`, shape(withRule));
  ok(shape(withRule) === shape(without), `${label}: classification equals the same row without the merchant rule`,
    `${shape(withRule)} vs ${shape(without)}`);
}

console.log('\n=== 2. explicit Lunch Money categories are not turned into Dog food by merchant ===');
for (const label of ['Groceries', 'Shopping', 'Fast Food']) {
  const withRule = classify(packetTx(label, { dogFood: true }));
  const without = classify(packetTx(label));
  ok(withRule.categoryId !== 'pets', `${label}: the dog-food merchant does not make it Dog food`, shape(withRule));
  ok(shape(withRule) === shape(without), `${label}: classification equals the same row without the merchant rule`,
    `${shape(withRule)} vs ${shape(without)}`);
}
{
  const groceries = classify(packetTx('Groceries', { dogFood: true }));
  ok(groceries.kind === 'spend' && groceries.categoryId === 'groceries', 'an explicit Groceries row at the dog-food merchant stays Groceries', shape(groceries));
}

console.log('\n=== 3. uncategorised rows still use the owner-confirmed merchant rule ===');
for (const label of [null, '', 'Uncategorised', 'Uncategorized']) {
  const fuel = classify(packetTx(label, { confirmedFuel: true }));
  ok(fuel.kind === 'spend' && fuel.categoryId === 'fuel', `${JSON.stringify(label)}: confirmed-fuel merchant → Fuel`, shape(fuel));
  const pets = classify(packetTx(label, { dogFood: true }));
  ok(pets.kind === 'spend' && pets.categoryId === 'pets', `${JSON.stringify(label)}: dog-food merchant → Dog food`, shape(pets));
}

console.log('\n=== 4. Lunch Money\'s own Fuel and Pets categories still work ===');
{
  const fuel = classify(packetTx('Fuel', {}, { displayedPayee: 'Invented Fuel Stop', originalMerchant: 'Invented Fuel Stop' }));
  ok(fuel.kind === 'spend' && fuel.categoryId === 'fuel', 'explicit Fuel at an invented merchant is Fuel', shape(fuel));
  const fuelAtRule = classify(packetTx('Fuel', { confirmedFuel: true }));
  ok(fuelAtRule.kind === 'spend' && fuelAtRule.categoryId === 'fuel', 'explicit Fuel at the confirmed merchant is still Fuel', shape(fuelAtRule));
  const pets = classify(packetTx('Pets', { dogFood: true }));
  ok(pets.kind === 'spend' && pets.categoryId === 'pets', 'explicit Pets at the dog-food merchant is Dog food', shape(pets));
}

console.log('\n=== 5. an exact owner-confirmed fuel transaction is owner evidence, not a merchant rule ===');
{
  const owner = classify(packetTx('Fast Food', { ownerConfirmedFuel: true, confirmedFuel: true }));
  ok(owner.kind === 'spend' && owner.categoryId === 'fuel', 'ownerConfirmedFuel keeps that one transaction Fuel', shape(owner));
}

console.log('\n=== 6. the grocery and guilt-free merchant rules follow the same authority ===');
{
  const rules = [
    ['confirmed-grocery merchant', { confirmedGrocery: true }, {}, 'groceries'],
    ['Dale guilt-free merchant', { daleGuiltFreeMerchant: true }, {}, 'dale-guilt-free'],
    ['Amazon on travelvisa', { amazonMerchant: true }, { atlasAccountId: 'travelvisa', account: 'travelvisa', accountRole: 'revolving-credit' }, 'amanda-guilt-free'],
  ];
  for (const [name, flags, over, want] of rules) {
    for (const label of ['Pets', 'Fast Food', 'Fuel', 'Restaurants']) {
      const withRule = classify(packetTx(label, flags, over));
      const without = classify(packetTx(label, {}, over));
      ok(withRule.categoryId !== want && shape(withRule) === shape(without),
        `${name} labelled ${label}: follows the Lunch Money category`, `${shape(withRule)} vs ${shape(without)}`);
    }
    for (const label of [null, 'Uncategorised']) {
      const cls = classify(packetTx(label, flags, over));
      ok(cls.kind === 'spend' && cls.categoryId === want,
        `${name} left ${JSON.stringify(label)}: the merchant rule still assigns ${want}`, shape(cls));
    }
  }
}

console.log('\n=== 7. an explicit label never drops a merchant-rule row from the household deduction (Atlas blocker 1) ===');
{
  // Invented Bills fixture: Bills 823.47 + income 263.19 − bill 17.23 −
  // commitment 9.41 − targets (71.13 + 29.27 = 100.40) = 959.62 with no
  // purchase. A 180.75 Weekly debit at the confirmed-fuel merchant that
  // Lunch Money labels Health (a mapped category with no Budget row) or
  // Bills (no matching bill) must stay deducted: Other spending has no
  // planned reserve, so the hold rises by 180.75 to 281.15 and the close
  // falls to 959.62 − 180.75 = 778.87.
  const fx = require('./fixtures/bills-period-end-balance-data');
  const health = { id: 'health', label: 'Health', class: 'essential', from: ['Health'], plannedMonthly: 0, confidence: 'confirmed' };
  const closeWith = (label, extraCategory) => {
    const x = fx.requirementsFixture();
    if (extraCategory) x.plan.budget.categories.push(extraCategory);
    if (label !== undefined) {
      x.opts.currentPeriodActuals.transactions.push(
        fx.tx('inv-fuel-identity', 'chequing-b', '2026-08-19', 180.75, label, { confirmedFuel: true }));
    }
    x.opts.observedCash.accounts.find(r => r.id === 'chequing-a').value = x.plan.startingCash.breakdown[0].value;
    return { x, r: F.billsAccountPeriodBalance(x.plan, x.asOf, x.opts) };
  };
  const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.005;
  const none = closeWith();
  ok(near(none.r.amount, 959.62) && near(none.r.household.target, 100.40), 'baseline close 959.62, hold 100.40', JSON.stringify([none.r.amount, none.r.household.target]));
  for (const [label, cat] of [['Health', health], ['Bills', null], ['Subscriptions', null]]) {
    const { x, r } = closeWith(label, cat);
    const tx = x.opts.currentPeriodActuals.transactions.find(t => t.id === 'inv-fuel-identity');
    const cls = F.classifyCurrentPeriodTransaction(tx, x.plan, {});
    // #922: the classifier core already holds an unmatched bill label for
    // confirmation (unmapped-label / bills-only-unmatched); H1's rewrite
    // reason applies to the other labels. The protected outcome is the same.
    ok(cls.needsConfirmation === true && cls.householdSpending === true && cls.kind !== 'bill'
        && ['lunchmoney-label-unbudgeted-merchant-row', 'unmapped-label', 'bills-only-unmatched'].includes(cls.reason),
      `${label}: the row is held for confirmation, not dropped`, shape(cls));
    ok(near(r.household.target, 281.15) && near(r.amount, 778.87) && r.issues.length === 0,
      `${label}: hold 281.15 and Bills close 778.87 keep the 180.75 deduction`, JSON.stringify([r.amount, r.household.target]));
  }
  // Controls: an explicit label onto a printed Budget row still wins, and a
  // row with no merchant rule keeps its incumbent treatment.
  const restaurants = classify(packetTx('Restaurants', { confirmedFuel: true }));
  ok(restaurants.kind === 'spend' && restaurants.categoryId === 'restaurants', 'Restaurants label onto a printed row still classifies Eating out', shape(restaurants));
  // #922: a Bills label alone, with no planned-bill match, is not a bill:
  // it is held for confirmation and counted. Matched to a planned bill it is
  // that bill.
  const plainBill = classify(packetTx('Bills'));
  ok(plainBill.kind !== 'bill' && plainBill.needsConfirmation === true && plainBill.householdSpending === true,
    'a Bills-labelled row with no merchant rule and no planned bill is held for confirmation (#922)', shape(plainBill));
  const representedBill = classify(packetTx('Bills', { representedBill: true }));
  ok(representedBill.kind === 'bill', 'a Bills-labelled row matched to a planned bill is that bill', shape(representedBill));
}

console.log('\n=== 8. lead ruling: Spent is conserved, no row is dropped, the hold is per-category on the LM category ===');
{
  // Lead ruling on #902 blocker 2: the per-category hold (max(planned,
  // spent) per category, owner rule 2026-09-04) applied to the Lunch Money
  // category is the spec. Invented plan: Groceries 71.13, Fuel 10.05,
  // Eating out 29.27 (planned total 110.45). One 180.75 Weekly debit at the
  // confirmed-fuel merchant, labelled differently each time. Hand holds:
  //   Fuel / uncategorised: 180.75 + 71.13 + 29.27      = 281.15
  //   Restaurants / Fast Food: 71.13 + 10.05 + 180.75   = 261.93
  //   Groceries: 180.75 + 10.05 + 29.27                 = 220.07
  //   Health / Bills / Gifts (Other, no planned reserve): 110.45 + 180.75 = 291.20
  const fx = require('./fixtures/bills-period-end-balance-data');
  const fuelCat = { id: 'fuel', label: 'Fuel', class: 'essential', from: ['Fuel'], plannedPayday: 10.05, confidence: 'confirmed' };
  const healthCat = { id: 'health', label: 'Health', class: 'essential', from: ['Health'], plannedMonthly: 0, confidence: 'confirmed' };
  const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.005;
  const budgetFor = label => {
    const x = fx.requirementsFixture();
    x.plan.budget.categories.push(fuelCat, healthCat);
    if (label !== undefined) {
      x.opts.currentPeriodActuals.transactions.push(
        fx.tx('inv-fuel-identity', 'chequing-b', '2026-08-19', 180.75, label, { confirmedFuel: true }));
    }
    const rec = F.recommend(x.plan, x.asOf, Object.assign({ targetBuffer: 0 }, x.opts));
    const period = (rec.defaultView.calendarPeriods || []).find(r => r.id === 'this-pay-period');
    const items = (period && period.householdBudget) || [];
    const spentTotal = Math.round(items.reduce((sum, i) => sum + (Number(i.spent) || 0), 0) * 100) / 100;
    return { spentTotal, hold: period && period.budgetHold, row: id => items.find(i => i.id === id) };
  };
  const none = budgetFor(undefined);
  ok(near(none.spentTotal, 0) && near(none.hold, 110.45), 'no purchase: Spent 0, hold = planned 110.45', JSON.stringify([none.spentTotal, none.hold]));
  const cases = [
    [null, 'fuel', 281.15], ['Fuel', 'fuel', 281.15],
    ['Restaurants', 'restaurants', 261.93], ['Fast Food', 'restaurants', 261.93],
    ['Groceries', 'groceries', 220.07],
    ['Health', 'other-spending', 291.20], ['Bills', 'other-spending', 291.20], ['Gifts', 'other-spending', 291.20],
  ];
  for (const [label, rowId, hold] of cases) {
    const b = budgetFor(label);
    const row = b.row(rowId);
    ok(near(b.spentTotal, 180.75), `${JSON.stringify(label)}: Spent is conserved at 180.75 (no row dropped)`, String(b.spentTotal));
    ok(row && near(Number(row.spent), 180.75), `${JSON.stringify(label)}: the 180.75 sits in ${rowId}`, JSON.stringify(row && row.spent));
    ok(near(b.hold, hold), `${JSON.stringify(label)}: hold is the per-category ${hold.toFixed(2)}`, String(b.hold));
  }
}

console.log('\n=== 9. no visible Budget row: an explicit label still keeps the merchant-rule row deducted (Atlas 6712117910) ===');
{
  // Every route by which an explicitly labelled merchant-rule row can land
  // in a category the window prints no row for: a $0 monthly target, the
  // category absent from the plan, an owner target not yet effective. Each
  // of the five merchant-rule families, through recommend (row visibility,
  // Spent, hold) and billsAccountPeriodBalance (close). Invented plan:
  // Groceries 71.13, Eating out 29.27, Fuel 10.05 (payday holds). The
  // 180.75 debit must appear in Other spending, needs confirmation; with no
  // planned reserve there, the hold rises and the close falls by 180.75.
  const fx = require('./fixtures/bills-period-end-balance-data');
  const fuelCat = { id: 'fuel', label: 'Fuel', class: 'essential', from: ['Fuel'], plannedPayday: 10.05, confidence: 'confirmed' };
  const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.005;
  const zero = id => cats => cats.map(c => c.id === id ? Object.assign({}, c, { plannedPayday: undefined, plannedMonthly: 0 }) : c);
  const routes = [
    ['Restaurants at a $0 monthly target', 'Restaurants', zero('restaurants')],
    ['Restaurants removed from the plan', 'Restaurants', cats => cats.filter(c => c.id !== 'restaurants')],
    ['Restaurants target not yet effective', 'Restaurants', cats => cats.map(c => c.id === 'restaurants'
      ? Object.assign({}, c, { targetEffectiveFrom: '2099-01-01' }) : c)],
    ['Fuel at a $0 monthly target', 'Fuel', zero('fuel')],
  ];
  const families = [
    ['fuel', { confirmedFuel: true }, 'chequing-b'], ['dog food', { dogFood: true }, 'chequing-b'],
    ['grocery', { confirmedGrocery: true }, 'chequing-b'], ['Dale guilt-free', { daleGuiltFreeMerchant: true }, 'chequing-b'],
    ['Amazon travel card', { amazonMerchant: true }, 'travelvisa'],
  ];
  const run = (mutate, label, flags, account) => {
    const x = fx.requirementsFixture();
    x.plan.budget.categories.push(fuelCat);
    x.plan.budget.categories = mutate(x.plan.budget.categories);
    if (label !== undefined) {
      x.opts.currentPeriodActuals.transactions.push(fx.tx('inv-no-row', account, '2026-08-19', 180.75, label, flags));
    }
    x.opts.observedCash.accounts.find(r => r.id === 'chequing-a').value = x.plan.startingCash.breakdown[0].value;
    const rec = F.recommend(x.plan, x.asOf, Object.assign({ targetBuffer: 0 }, x.opts));
    const period = (rec.defaultView.calendarPeriods || []).find(r => r.id === 'this-pay-period');
    const items = (period && period.householdBudget) || [];
    const spent = Math.round(items.reduce((s, i) => s + (Number(i.spent) || 0), 0) * 100) / 100;
    const close = F.billsAccountPeriodBalance(x.plan, x.asOf, x.opts);
    return { items, spent, hold: period && period.budgetHold, close: close.amount };
  };
  for (const [route, label, mutate] of routes) {
    const base = run(mutate, undefined);
    const rowId = label === 'Fuel' ? 'fuel' : 'restaurants';
    ok(!base.items.some(i => i.id === rowId), `${route}: the window prints no ${rowId} row`, base.items.map(i => i.id).join(','));
    for (const [family, flags, account] of families) {
      const r = run(mutate, label, flags, account);
      const other = r.items.find(i => i.id === 'other-spending');
      ok(other && near(Number(other.spent), 180.75), `${route}, ${family} merchant: the 180.75 is visible in Other spending`,
        JSON.stringify(other && other.spent));
      ok(near(r.spent - base.spent, 180.75), `${route}, ${family} merchant: Spent rises by 180.75`, String(r.spent - base.spent));
      ok(near(r.hold - base.hold, 180.75), `${route}, ${family} merchant: hold rises by 180.75`, `${base.hold} → ${r.hold}`);
      ok(near(base.close - r.close, 180.75), `${route}, ${family} merchant: Bills close falls by 180.75`, `${base.close} → ${r.close}`);
    }
  }
  // Controls. The uncategorised merchant rule and a plain labelled row with
  // no merchant rule keep their incumbent treatment at a $0 target (the
  // owner's explicit zero baseline); only the explicit-label override is
  // retained here.
  const zeroRest = zero('restaurants');
  const base = run(zeroRest, undefined);
  const plain = run(zeroRest, 'Restaurants', {}, 'chequing-b');
  ok(near(plain.spent, base.spent) && near(plain.close, base.close),
    'control: a Restaurants row with no merchant rule at a $0 target is unchanged (not counted)', JSON.stringify([plain.spent, plain.close]));
  const printed = run(c => c, 'Restaurants', { confirmedFuel: true }, 'chequing-b');
  const eatingOut = printed.items.find(i => i.id === 'restaurants');
  ok(eatingOut && near(Number(eatingOut.spent), 180.75) && !printed.items.some(i => i.id === 'other-spending' && Number(i.spent) > 0),
    'control: with a printed Eating out row the label still decides (180.75 in Eating out, nothing in Other)', JSON.stringify(eatingOut && eatingOut.spent));
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'All H1 Lunch Money category authority checks passed'));
process.exit(failures ? 1 : 0);
