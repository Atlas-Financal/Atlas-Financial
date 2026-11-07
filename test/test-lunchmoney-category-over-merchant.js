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

console.log('\n' + (failures ? `${failures} failure(s)` : 'All H1 Lunch Money category authority checks passed'));
process.exit(failures ? 1 : 0);
