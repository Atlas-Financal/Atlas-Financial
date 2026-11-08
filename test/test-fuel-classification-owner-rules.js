'use strict';
/* Dale 2026-10-14, as refined the same day (owner clarification via
 * Atlas, Slack ts 1792014972.832679; bounded revision approved ts
 * 1792015037.601409): purchase categories are controlled in Lunch
 * Money; Atlas reflects them after refresh. The deciding rule does NOT
 * live in Atlas as a merchant ruleset.
 *
 *   What stands: an exact Lunch Money "Fuel" category is itself
 *   explicit fuel evidence in Atlas. A purchase the owner categorized
 *   Fuel classifies as Fuel at any amount, at any merchant, including
 *   with no merchant identity at all. This supersedes the 2026-09-23
 *   rule that held a convenience-store Fuel row for confirmation
 *   unless a note / tag / MCC / kind hint corroborated it.
 *
 *   What was removed: the same-day Atlas-side amount override ("a
 *   7-Eleven purchase over $30 is Fuel") and the exclusion scaffolding
 *   built to protect it across two Systems Review rounds. A Fast Food
 *   or Shopping purchase must NOT become Fuel because of its merchant
 *   or amount; to make a 7-Eleven fill-up count as fuel, its category
 *   is set in Lunch Money.
 *
 * The pins below therefore assert category parity: for non-Fuel
 * categories the classifier's outcome is exactly the base (pre-#614)
 * outcome at below / exactly / above $30, in raw and packet shapes —
 * including the two review rounds' exclusion controls (excluded
 * transfer rows stay transfers, excluded Shopping stays Business,
 * owner-evidence shopping stays guilt-free, and an excluded Fast Food
 * purchase stays Eating out even when Fast Food has no plan alias).
 *
 * Synthetic fixtures only. No provider access, no Lunch Money write.
 *
 * `node test/test-fuel-classification-owner-rules.js`
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');

const ROOT = path.join(__dirname, '..');
const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8')).plan;

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

/* Raw shape: no precomputed flags; the classifier derives merchant
 * identity and evidence from the transaction's own fields. */
function rawTx(over) {
  return Object.assign({
    id: 'fuel-rules-raw-1', date: '2026-10-08', amount: 50.00, pending: false,
    categoryLabel: 'Fuel',
    payee: '7-Eleven', originalMerchant: '7-Eleven', displayedPayee: '7-Eleven',
    notes: null, tags: null, mcc: null, kindHint: null,
    isIncome: false, excludeFromTotals: false,
    accountRole: 'household-cash', atlasAccountId: 'chequinga', account: 'chequinga',
  }, over || {});
}

/* Packet shape: exactly the fields provider-observe publishes into the
 * canonical current-period packet, with flags as the observer stamps
 * them for an uncategorized-evidence 7-Eleven purchase. */
function packetTx(over) {
  return Object.assign({
    id: 'fuel-rules-packet-1', date: '2026-10-08', amount: 50.00, pending: false,
    categoryLabel: 'Fuel',
    displayedPayee: '7-Eleven', originalMerchant: '7-Eleven',
    isIncome: false, excludeFromTotals: false, excludeFromBudget: false,
    accountRole: 'household-cash', atlasAccountId: 'chequinga', account: 'chequinga',
    kindHint: null,
    dogFood: false, convenienceStore: true, canadianTire: false,
    groceryUncertain: false, groceryMixed: false, merchantKnown: true,
    fuelEvidence: false, confirmedGrocery: false, confirmedFuel: false,
    ownerConfirmedFuel: false,
  }, over || {});
}

function classify(tx) {
  return F.classifyCurrentPeriodTransaction(tx, plan, {});
}
function classifyWith(tx, p) {
  return F.classifyCurrentPeriodTransaction(tx, p, {});
}
function isFuel(cls) {
  return !!cls && cls.kind === 'spend' && cls.categoryId === 'fuel';
}
function describe(cls) {
  return cls ? `${cls.kind}/${cls.categoryId}/${cls.includeReason || cls.reason}` : 'null';
}

/* A plan variant with NO category aliasing 'fast food' — the second
 * review round's scope case: Eating out precedence must hold
 * independently of whether a plan alias exists. */
const normLabel = s => String(s || '').trim().toLowerCase();
const aliasLessPlan = JSON.parse(JSON.stringify(plan));
aliasLessPlan.budget.categories = (aliasLessPlan.budget.categories || []).filter(c =>
  ![c.id, c.label].concat(c.from || []).map(normLabel).includes('fast food'));

console.log('\n=== the Fuel label is explicit fuel evidence (retained) ===');
{
  const packet = classify(packetTx({}));
  ok(isFuel(packet) && packet.includeReason === 'fuel-category',
    'packet: 7-Eleven + Fuel category, no corroborating flag -> Fuel',
    describe(packet));
  const raw = classify(rawTx({}));
  ok(isFuel(raw) && raw.includeReason === 'fuel-category',
    'raw: 7-Eleven + Fuel category, no note/tag/MCC -> Fuel',
    describe(raw));
  const circleK = classify(rawTx({
    payee: 'Circle K', originalMerchant: 'Circle K', displayedPayee: 'Circle K',
  }));
  ok(isFuel(circleK) && circleK.includeReason === 'fuel-category',
    'raw: Circle K + Fuel category -> Fuel (the admission is the evidence rule, not a merchant sweep)',
    describe(circleK));
  const noMerchant = classify(rawTx({
    payee: '', originalMerchant: null, displayedPayee: null,
  }));
  ok(isFuel(noMerchant) && noMerchant.includeReason === 'fuel-category',
    'raw: Fuel category with no merchant identity -> Fuel (the category is the evidence; fuel-merchant-missing no longer holds it)',
    describe(noMerchant));
  const noted = classify(rawTx({ notes: 'Fuel for the truck' }));
  ok(isFuel(noted) && noted.includeReason === 'fuel-category',
    'control: 7-Eleven + Fuel + fuel note still Fuel',
    describe(noted));
  const ownerExact = classify(packetTx({
    date: '2026-09-22', amount: 75.00, atlasAccountId: 'chequingb', account: 'chequingb',
  }));
  ok(isFuel(ownerExact) && ownerExact.includeReason === 'fuel-merchant',
    'control: the exact owner-confirmed September 2026 transaction still classifies by identity first',
    describe(ownerExact));
  const flags = F.classifyCurrentPeriodTransaction.derivedFlags(rawTx({}));
  ok(flags.fuelEvidence === true && flags.convenienceStore === true,
    'derivedFlags: the observer now stamps fuelEvidence for an exact Fuel category',
    JSON.stringify({ fuelEvidence: flags.fuelEvidence, convenienceStore: flags.convenienceStore }));
}

console.log('\n=== category-change controls: the Lunch Money category decides, at any amount ===');
{
  // A transaction whose category IS Fuel classifies as Fuel below,
  // exactly at, and above the removed rule's $30 line.
  for (const amount of [12.00, 30.00, 44.19]) {
    const raw = classify(rawTx({ amount }));
    ok(isFuel(raw) && raw.includeReason === 'fuel-category',
      `raw: 7-Eleven $${amount.toFixed(2)} Fuel category -> Fuel`,
      describe(raw));
    const packet = classify(packetTx({ amount }));
    ok(isFuel(packet) && packet.includeReason === 'fuel-category',
      `packet: 7-Eleven $${amount.toFixed(2)} Fuel category -> Fuel`,
      describe(packet));
  }
  // A non-Fuel category at 7-Eleven NEVER becomes Fuel — not above
  // $30, not at any amount. Each outcome is the base outcome.
  const shopping = classify(rawTx({ categoryLabel: 'Shopping', amount: 44.19 }));
  ok(!isFuel(shopping) && shopping.reason === 'personal-unassigned',
    'raw: 7-Eleven $44.19 Shopping -> NOT Fuel (base personal-unassigned; merchant/amount never reclassify)',
    describe(shopping));
  const shoppingPacket = classify(packetTx({ categoryLabel: 'Shopping', amount: 44.19 }));
  ok(!isFuel(shoppingPacket) && shoppingPacket.reason === 'personal-unassigned',
    'packet: 7-Eleven $44.19 Shopping -> NOT Fuel through the canonical packet shape',
    describe(shoppingPacket));
  const justOver = classify(rawTx({ categoryLabel: 'Shopping', amount: 30.01 }));
  ok(!isFuel(justOver) && justOver.reason === 'personal-unassigned',
    'raw: 7-Eleven $30.01 Shopping -> NOT Fuel (the removed override fired here)',
    describe(justOver));
  const fastFoodOver = classify(rawTx({ categoryLabel: 'Fast Food', amount: 35.00 }));
  ok(fastFoodOver.kind === 'spend' && fastFoodOver.categoryId === 'restaurants'
      && fastFoodOver.includeReason === 'eating-out-category',
    'raw: 7-Eleven $35.00 Fast Food -> Eating out, NOT Fuel',
    describe(fastFoodOver));
  const household = classify(rawTx({ categoryLabel: 'Household', amount: 50.00 }));
  ok(!isFuel(household) && household.kind === 'spend' && household.categoryId === 'household',
    'raw: 7-Eleven $50.00 Household -> Household, NOT Fuel',
    describe(household));
  const groceries = classify(rawTx({ categoryLabel: 'Groceries', amount: 50.00 }));
  ok(!isFuel(groceries) && groceries.kind === 'spend' && groceries.categoryId === 'groceries',
    'raw: 7-Eleven $50.00 Groceries -> Groceries, NOT Fuel',
    describe(groceries));
  const noCategory = classify(rawTx({ categoryLabel: null, amount: 50.00 }));
  ok(!isFuel(noCategory) && noCategory.reason === 'no-category',
    'raw: 7-Eleven $50.00 with no category -> base no-category confirmation, NOT Fuel',
    describe(noCategory));
  const variant = classify(rawTx({
    categoryLabel: 'Shopping', amount: 50.00,
    payee: '7-ELEVEN 4451', originalMerchant: '7-ELEVEN 4451', displayedPayee: '7-ELEVEN 4451',
  }));
  ok(!isFuel(variant) && variant.reason === 'personal-unassigned',
    'raw: "7-ELEVEN 4451" $50.00 Shopping -> NOT Fuel (store-number variant changes nothing)',
    describe(variant));
  const transportation = classify(rawTx({ categoryLabel: 'Transportation', amount: 50.00 }));
  ok(!isFuel(transportation) && transportation.reason === 'unmapped-label',
    'raw: 7-Eleven $50.00 Transportation -> still unmapped-label (no merchant reclassification, no alias added)',
    describe(transportation));
}

console.log('\n=== below / exactly $30: base behaviour, and the Fuel label decides at every amount ===');
{
  const exactThirty = classify(rawTx({ categoryLabel: 'Shopping', amount: 30.00 }));
  ok(!isFuel(exactThirty) && exactThirty.reason === 'personal-unassigned',
    'raw: 7-Eleven exactly $30.00 Shopping -> NOT Fuel; base personal-unassigned preserved',
    describe(exactThirty));
  const exactThirtyPacket = classify(packetTx({ categoryLabel: 'Shopping', amount: 30.00 }));
  ok(!isFuel(exactThirtyPacket) && exactThirtyPacket.reason === 'personal-unassigned',
    'packet: 7-Eleven exactly $30.00 Shopping -> NOT Fuel',
    describe(exactThirtyPacket));
  const justUnder = classify(rawTx({ categoryLabel: 'Shopping', amount: 29.99 }));
  ok(!isFuel(justUnder) && justUnder.reason === 'personal-unassigned',
    'raw: 7-Eleven $29.99 Shopping -> NOT Fuel; base behaviour preserved',
    describe(justUnder));
  const snack = classify(rawTx({ categoryLabel: 'Fast Food', amount: 12.00 }));
  ok(snack.kind === 'spend' && snack.categoryId === 'restaurants'
      && snack.includeReason === 'eating-out-category',
    'raw: 7-Eleven $12.00 Fast Food -> Eating out (owner 2026-09-17 snack treatment retained)',
    describe(snack));
  const snackPacket = classify(packetTx({ categoryLabel: 'Fast Food', amount: 12.00 }));
  ok(snackPacket.kind === 'spend' && snackPacket.categoryId === 'restaurants'
      && snackPacket.includeReason === 'eating-out-category',
    'packet: 7-Eleven $12.00 Fast Food -> Eating out',
    describe(snackPacket));
  const fuelUnder = classify(rawTx({ amount: 29.99 }));
  ok(isFuel(fuelUnder) && fuelUnder.includeReason === 'fuel-category',
    'raw: 7-Eleven $29.99 Fuel -> Fuel by its category (the evidence rule has no amount floor)',
    describe(fuelUnder));
  const noCategoryUnder = classify(rawTx({ categoryLabel: null, amount: 25.00 }));
  ok(!isFuel(noCategoryUnder) && noCategoryUnder.reason === 'no-category',
    'raw: 7-Eleven $25.00 with no category -> base no-category confirmation',
    describe(noCategoryUnder));
}

console.log('\n=== no broadening: other merchants and unadded aliases ===');
{
  const circleKShopping = classify(rawTx({
    categoryLabel: 'Shopping', amount: 44.19,
    payee: 'Circle K', originalMerchant: 'Circle K', displayedPayee: 'Circle K',
  }));
  ok(!isFuel(circleKShopping) && circleKShopping.reason === 'personal-unassigned',
    'raw: Circle K $44.19 Shopping -> NOT Fuel',
    describe(circleKShopping));
  const cornerShopping = classify(rawTx({
    categoryLabel: 'Shopping', amount: 44.19,
    payee: 'CORNER MARKET', originalMerchant: 'CORNER MARKET', displayedPayee: 'CORNER MARKET',
  }));
  ok(!isFuel(cornerShopping) && cornerShopping.reason === 'personal-unassigned',
    'raw: CORNER MARKET $44.19 Shopping -> NOT Fuel',
    describe(cornerShopping));
  const petroFuel = classify(rawTx({
    payee: 'PETRO-CANADA', originalMerchant: 'PETRO-CANADA', displayedPayee: 'PETRO-CANADA',
  }));
  ok(isFuel(petroFuel) && petroFuel.includeReason === 'fuel-category',
    'control: Petro-Canada + Fuel -> Fuel, unchanged',
    describe(petroFuel));
  const petroShopping = classify(rawTx({
    categoryLabel: 'Shopping', amount: 50.00,
    payee: 'PETRO-CANADA', originalMerchant: 'PETRO-CANADA', displayedPayee: 'PETRO-CANADA',
  }));
  ok(!isFuel(petroShopping) && petroShopping.reason === 'personal-unassigned',
    'raw: Petro-Canada $50.00 Shopping -> NOT Fuel',
    describe(petroShopping));
  const transportationOtherMerchant = classify(rawTx({
    categoryLabel: 'Transportation', amount: 50.00,
    payee: 'PETRO-CANADA', originalMerchant: 'PETRO-CANADA', displayedPayee: 'PETRO-CANADA',
  }));
  ok(!isFuel(transportationOtherMerchant) && transportationOtherMerchant.reason === 'unmapped-label',
    'raw: Petro-Canada $50.00 Transportation -> still unmapped-label (no Transportation/Ridesharing alias added)',
    describe(transportationOtherMerchant));
  const transportationUnder = classify(rawTx({ categoryLabel: 'Transportation', amount: 25.00 }));
  ok(!isFuel(transportationUnder) && transportationUnder.reason === 'unmapped-label',
    'raw: 7-Eleven $25.00 Transportation -> still unmapped-label',
    describe(transportationUnder));
}

console.log('\n=== non-purchase movements keep their incumbent identities ===');
{
  const refundAmount = classify(rawTx({ categoryLabel: 'Shopping', amount: -50.00 }));
  ok(refundAmount.kind === 'refund',
    '7-Eleven -$50.00 -> refund (negative amount is a non-purchase identity)',
    describe(refundAmount));
  // A credit in a Refund category is a refund. A debit (money leaving)
  // under a Refund label is not an invisible refund: it is household
  // spending that needs confirmation.
  const refundLabelCredit = classify(rawTx({ categoryLabel: 'Refund', amount: -50.00 }));
  ok(refundLabelCredit.kind === 'refund',
    '7-Eleven -$50.00 credit in Refund category -> refund',
    describe(refundLabelCredit));
  const refundLabel = classify(rawTx({ categoryLabel: 'Refund', amount: 50.00 }));
  ok(refundLabel.kind === 'unclassified' && refundLabel.needsConfirmation === true
      && refundLabel.householdSpending === true && refundLabel.categoryId === 'uncategorised',
    '7-Eleven $50.00 debit in Refund category -> spending needing confirmation',
    describe(refundLabel));
  // The refund label never pre-empts another owner: a Refund-labelled debit
  // with a payment kind hint is still the card payment.
  const refundLabelPayment = classify(rawTx({ categoryLabel: 'Refund', amount: 50.00, kindHint: 'payment' }));
  ok(refundLabelPayment.kind === 'card-payment',
    '7-Eleven $50.00 Refund-labelled debit with a payment kind hint -> card-payment',
    describe(refundLabelPayment));
  const transferLabel = classify(rawTx({ categoryLabel: 'Transfer', amount: 50.00 }));
  ok(transferLabel.kind === 'transfer',
    '7-Eleven $50.00 Transfer category -> transfer',
    describe(transferLabel));
  const cardPayment = classify(rawTx({ categoryLabel: 'Shopping', amount: 50.00, kindHint: 'payment' }));
  ok(cardPayment.kind === 'card-payment',
    '7-Eleven $50.00 with a payment kind hint -> card-payment',
    describe(cardPayment));
  // Lunch Money credits are negative: an income-flagged credit is income.
  const income = classify(rawTx({ categoryLabel: 'Shopping', amount: -50.00, isIncome: true }));
  ok(income.kind === 'income',
    '7-Eleven -$50.00 credit flagged income -> income',
    describe(income));
  // A debit (money leaving) in an income category is never income: it is
  // household spending that needs confirmation.
  const incomeDebit = classify(rawTx({ categoryLabel: 'Shopping', amount: 50.00, isIncome: true }));
  ok(incomeDebit.kind === 'unclassified' && incomeDebit.needsConfirmation === true
      && incomeDebit.householdSpending === true && incomeDebit.reason === 'income-category-debit',
    '7-Eleven $50.00 debit flagged income -> spending needing confirmation, not income',
    describe(incomeDebit));
  // Another owner still claims an income-flagged debit first, so it is
  // counted once: a card payment stays a card payment, a transfer a transfer.
  const incomeDebitPayment = classify(rawTx({ categoryLabel: 'Shopping', amount: 50.00, isIncome: true, kindHint: 'payment' }));
  ok(incomeDebitPayment.kind === 'card-payment',
    '7-Eleven $50.00 debit flagged income with a payment kind hint -> card-payment',
    describe(incomeDebitPayment));
  const incomeDebitTransfer = classify(rawTx({ categoryLabel: 'Transfer', amount: 50.00, isIncome: true }));
  ok(incomeDebitTransfer.kind === 'transfer',
    '7-Eleven $50.00 debit flagged income in a Transfer category -> transfer',
    describe(incomeDebitTransfer));
}

console.log('\n=== precedence kept: owner categories and Business keep their incumbent outcomes ===');
{
  const dale = classify(rawTx({ categoryLabel: 'Dale', amount: 50.00 }));
  ok(dale.kind === 'spend' && dale.categoryId === 'dale-guilt-free',
    '7-Eleven $50.00 Dale category -> Dale guilt-free',
    describe(dale));
  const business = classify(rawTx({ categoryLabel: 'Business', amount: 50.00 }));
  ok(business.kind === 'business',
    '7-Eleven $50.00 Business category -> Business exclusion, not Fuel',
    describe(business));
}

console.log('\n=== review-round controls: exclusion / non-purchase parity with base ===');
{
  // Round 1 (BLOCK on 7042c9a3): excluded and owner-attributed rows
  // must keep their base outcomes. With the amount override removed
  // these pin plain base parity — the classifier code path is the
  // incumbent one.
  const exclTransferRaw = classify(rawTx({ categoryLabel: null, excludeFromTotals: true, amount: 50.00 }));
  ok(exclTransferRaw.kind === 'transfer' && exclTransferRaw.reason === 'exclude-from-totals',
    'raw: 7-Eleven $50.00 excluded transfer row (no category) -> transfer, NOT Fuel',
    describe(exclTransferRaw));
  const exclTransferPacket = classify(packetTx({ categoryLabel: null, excludeFromTotals: true, amount: 50.00 }));
  ok(exclTransferPacket.kind === 'transfer' && exclTransferPacket.reason === 'exclude-from-totals',
    'packet: 7-Eleven $50.00 excluded transfer row (no category) -> transfer, NOT Fuel',
    describe(exclTransferPacket));
  const exclShoppingRaw = classify(rawTx({ categoryLabel: 'Shopping', personalOwner: 'excluded', amount: 50.00 }));
  ok(exclShoppingRaw.kind === 'business' && exclShoppingRaw.reason === 'personal-excluded',
    'raw: 7-Eleven $50.00 Shopping with excluded owner evidence -> Business, NOT Fuel',
    describe(exclShoppingRaw));
  const exclShoppingPacket = classify(packetTx({ categoryLabel: 'Shopping', personalOwner: 'excluded', amount: 50.00 }));
  ok(exclShoppingPacket.kind === 'business' && exclShoppingPacket.reason === 'personal-excluded',
    'packet: 7-Eleven $50.00 Shopping with excluded owner evidence -> Business, NOT Fuel',
    describe(exclShoppingPacket));
  const exclPersonalAlias = classify(rawTx({ categoryLabel: 'Personal', personalOwner: 'excluded', amount: 50.00 }));
  ok(exclPersonalAlias.kind === 'business' && exclPersonalAlias.reason === 'personal-excluded',
    'raw: 7-Eleven $50.00 Personal (shopping alias) with excluded owner evidence -> Business, NOT Fuel',
    describe(exclPersonalAlias));
  const daleEvidence = classify(rawTx({ categoryLabel: 'Shopping', personalOwner: 'dale', amount: 50.00 }));
  ok(daleEvidence.kind === 'spend' && daleEvidence.categoryId === 'dale-guilt-free'
      && daleEvidence.includeReason === 'owner-evidence-dale',
    'raw: 7-Eleven $50.00 Shopping with Dale owner evidence -> Dale guilt-free, NOT Fuel',
    describe(daleEvidence));
  const amandaEvidence = classify(rawTx({ categoryLabel: 'Shopping', personalOwner: 'amanda', amount: 50.00 }));
  ok(amandaEvidence.kind === 'spend' && amandaEvidence.categoryId === 'amanda-guilt-free'
      && amandaEvidence.includeReason === 'owner-evidence-amanda',
    'raw: 7-Eleven $50.00 Shopping with Amanda owner evidence -> Amanda guilt-free, NOT Fuel',
    describe(amandaEvidence));
  const exclFlagMatchedPurchase = classify(rawTx({ categoryLabel: 'Shopping', excludeFromTotals: true, amount: 50.00 }));
  ok(!isFuel(exclFlagMatchedPurchase) && exclFlagMatchedPurchase.reason === 'personal-unassigned',
    'control: an exclude-from-totals flag on a matched purchase row classifies by category, exactly as on base (Shopping -> personal-unassigned), NOT Fuel',
    describe(exclFlagMatchedPurchase));

  // Round 2 (BLOCK on efbaba6a): Eating out precedence is independent
  // of plan aliases. An excluded Fast Food purchase is Eating out
  // spending — never a transfer — with or without a 'fast food' plan
  // alias, at a café or at 7-Eleven.
  const cafe = { payee: 'Corner Cafe', originalMerchant: 'Corner Cafe', displayedPayee: 'Corner Cafe' };
  const cafeExclNoAlias = classifyWith(rawTx({ ...cafe, categoryLabel: 'Fast Food', amount: 12.00, excludeFromTotals: true }), aliasLessPlan);
  ok(cafeExclNoAlias.kind === 'spend' && cafeExclNoAlias.categoryId === 'restaurants'
      && cafeExclNoAlias.includeReason === 'eating-out-category',
    'raw: excluded $12.00 cafe Fast Food with NO fast-food plan alias -> Eating out, NOT transfer',
    describe(cafeExclNoAlias));
  const cafeExclPacket = classify(packetTx({ ...cafe, categoryLabel: 'Fast Food', amount: 12.00, excludeFromTotals: true, convenienceStore: false }));
  ok(cafeExclPacket.kind === 'spend' && cafeExclPacket.categoryId === 'restaurants'
      && cafeExclPacket.includeReason === 'eating-out-category',
    'packet: excluded $12.00 cafe Fast Food -> Eating out, NOT transfer',
    describe(cafeExclPacket));
  const cafeExclFullPlan = classify(rawTx({ ...cafe, categoryLabel: 'Fast Food', amount: 12.00, excludeFromTotals: true }));
  ok(cafeExclFullPlan.kind === 'spend' && cafeExclFullPlan.categoryId === 'restaurants'
      && cafeExclFullPlan.includeReason === 'eating-out-category',
    'control: excluded $12.00 cafe Fast Food with the full plan -> Eating out (alias presence changes nothing)',
    describe(cafeExclFullPlan));
  const sevenExclNoAlias = classifyWith(rawTx({ categoryLabel: 'Fast Food', amount: 12.00, excludeFromTotals: true }), aliasLessPlan);
  ok(sevenExclNoAlias.kind === 'spend' && sevenExclNoAlias.categoryId === 'restaurants'
      && sevenExclNoAlias.includeReason === 'eating-out-category',
    'raw: excluded $12.00 7-Eleven Fast Food with NO fast-food plan alias -> Eating out, NOT transfer',
    describe(sevenExclNoAlias));
  const cafeExclNoCategory = classify(rawTx({ ...cafe, categoryLabel: null, excludeFromTotals: true, amount: 12.00 }));
  ok(cafeExclNoCategory.kind === 'transfer' && cafeExclNoCategory.reason === 'exclude-from-totals',
    'control: excluded cafe row with no purchase category -> transfer (non-purchase protection intact)',
    describe(cafeExclNoCategory));
}

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nfuel classification owner rules: ok');
