'use strict';
// Dale's direction (lead dispatch 2026-11-18): one card payment whose card
// Atlas cannot confirm never takes the plan down. A posted TD "TFR-TO C/C"
// debit out of Bills (or Savings) with no note, no LM group and no matching
// card credit has already left that account, and the observed balance holds
// it. It is applied to NO card: every card purchase stays reserved as if
// unpaid. That can only understate the money left, never overstate it. The
// plan stays live, the payment is one "To confirm: which card did this pay?"
// row, and every figure built on the card coverage carries an estimated tag.
// Money-moving proposals (extra debt, the future path) still wait. A credit
// back into Bills from an unknown card, a debit out of Weekly, or the
// destination beside any other card issue, withholds exactly as before. A note, group or credit resolves
// it as today. Invented numbers only; every expected figure is hand-derived.
//
// World (test/fixtures/card-coverage-aggregate-world.js): payday anchor
// 2026-09-18, Bills 500, Travel Visa debt 400, groceries allowance 150, a 25
// Travel Visa minimum due on the as-of 2026-09-20, one 80 card purchase.
//
// Hand-derived, a 105 Bills debit with no note (Bills observed 395):
//   degraded (applied to no card): 395 - 25 minimum - 70 groceries left
//     - 80 purchase reserve = 220 available now;
//   truth if it paid Travel Visa: minimum and purchase covered, 395 - 0 - 70
//     - 0 = 325;
//   truth if it paid any other card (or nothing tracked): 220.
// So 220 <= every truth.
const assert = require('node:assert/strict');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };
const transfer = { category_name: 'Transfer' };
const purchase = ['card', 80, null, 'purchase'];
const cashLeg = (amount, extra = {}, account = 'bills') => [account, amount, null, 'cash',
  { payee: 'AB123 TFR-TO C/C', original_name: 'AB123 TFR-TO C/C', ...transfer, ...extra }];
// The fixture's own card-payment credit (its PAYMENT - THANK YOU label, filed
// under Credit Card Payment), as the aggregate-rule tests pair it.
const cardCredit = (account, amount) => [account, -amount, null, 'credit'];
const TRAVEL = 'card payment: Travel Visa ...9999';
const codes = s => (s.coverage.issues || []).map(i => i.code);

// Money-left figures, which must never exceed the truth, and the reserve,
// which must never fall below it.
function moneyLeft(s) {
  const a = s.advice, pa = a.paydayAllocation || {};
  const out = {
    availableNow: s.period.fromTodayFunding.availableNow,
    weeklyCap: pa.weeklyCap, spendPermission: pa.spendPermission, supportedAllowance: pa.supportedAllowance,
    paydayAvailable: pa.available,
    savingsAvailableNow: a.savingsFunding?.period?.availableNow,
  };
  for (const p of a.payPeriodViews.filter(v => v.plannedPeriodClose != null)) out['close@' + p.start] = p.plannedPeriodClose;
  return out;
}
function atMostTruth(degraded, truth, why) {
  const d = moneyLeft(degraded), t = moneyLeft(truth);
  for (const [k, v] of Object.entries(d)) {
    if (v == null) continue;
    check(t[k] != null, `${why}: ${k} is published in the truth case too`);
    check(v <= t[k] + 1e-9, `${why}: ${k} ${v} <= truth ${t[k]}`);
  }
  check(degraded.coverage.reservedCash >= truth.coverage.reservedCash,
    `${why}: reserve ${degraded.coverage.reservedCash} >= truth ${truth.coverage.reservedCash}`);
}
// Every trust-like tag in the whole recommend output.
function tags(advice) {
  const out = {};
  (function walk(o, p) {
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
      if (/(trust|Trust|confidence|Confidence)$/.test(k) && typeof v === 'string') out[p + k] = v;
      if (v && typeof v === 'object') walk(v, p + k + '.');
    }
  })(advice, '');
  return out;
}
const RANK = { estimated: 1, calculated: 2, confirmed: 3, verified: 4 };
const degradedShape = (s, why, { amount = 105, from = 'chequing-a', count = 1, cashFigures = true } = {}) => {
  check(s.observed.data.liveOverlay.operatingPlan === 'live', why + ': the plan stays live');
  check(s.coverage.status === 'ready' && codes(s).length === 0, why + ': coverage published, no withholding issue');
  check(s.coverage.trust === 'estimated' && s.coverage.estimateBasis === 'card-payment-destination-unconfirmed',
    why + ': coverage is an estimate, with its basis');
  check(s.coverage.toConfirm.length === count && s.coverage.toConfirm.every(r => r.question === 'To confirm: which card did this pay?'),
    why + ': one To-confirm row per payment');
  if (count === 1) check(s.coverage.toConfirm[0].amount === amount && s.coverage.toConfirm[0].fromAccount === from,
    why + ': the row names the amount and the household account it left');
  // A movement out of Savings withholds today's cash figures for its own,
  // unrelated reason (reported-balance cutoffs), confirmed payment or not.
  if (!cashFigures) return;
  const f = s.period.fromTodayFunding;
  check(f.availableNow != null && f.trust === 'estimated', why + ': available now is published and estimated');
  check(s.period.plannedPeriodClose != null && s.period.plannedPeriodCloseTrust === 'estimated', why + ': the close is estimated');
  const pa = s.advice.paydayAllocation;
  check(pa.paydayShellTrust.available === 'estimated' && pa.paydayShellTrust.household === 'estimated',
    why + ': payday available and household allowance are estimated');
  check(pa.extraDebt.status === 'unavailable' && pa.extraDebt.allocated == null && pa.movable == null
    && pa.protectedPath.status === 'unavailable', why + ': money-moving proposals still wait');
};

console.log('1. The live case: one 105 Bills debit, no note');
const degraded = run(world([purchase, cashLeg(105)]));
degradedShape(degraded, 'no note');
check(degraded.period.fromTodayFunding.availableNow === 220, 'available now is the hand-derived 220');
check(degraded.coverage.reservedCash === 80, 'the 80 purchase stays reserved as if unpaid');

console.log('2. Never above the truth, whichever card it paid (or none tracked)');
{
  const paidTravel = run(world([purchase, cashLeg(105, { notes: TRAVEL })]));
  check(paidTravel.coverage.status === 'ready' && paidTravel.coverage.trust === undefined
    && paidTravel.period.fromTodayFunding.availableNow === 325, 'truth A (paid Travel Visa): 325, calculated');
  atMostTruth(degraded, paidTravel, 'vs truth A (Travel Visa)');
  // Truth B: the same debit is confirmed to a second card that holds no
  // purchase (the second card's own payment credit pairs with it): nothing
  // on Travel Visa is covered, the same as paying no tracked card at all.
  const degraded2 = run(world([purchase, cashLeg(105)], { twoCards: true }));
  const paidOther = run(world([purchase, cashLeg(105), cardCredit('card2', 105)], { twoCards: true }));
  check(paidOther.coverage.status === 'ready' && paidOther.coverage.trust === undefined, 'truth B (another card) is calculated');
  degradedShape(degraded2, 'two cards, no note');
  atMostTruth(degraded2, paidOther, 'vs truth B (another card, nothing tracked covered)');
  check(degraded2.period.fromTodayFunding.availableNow === paidOther.period.fromTodayFunding.availableNow,
    'paying a card with nothing tracked equals the degraded figure: the estimate is tight there');
  // Purchases on both cards: never above either truth.
  const both = r => run(world([purchase, ['card2', 40, null, 'purchase'], ...r], { twoCards: true }));
  const degradedBoth = both([cashLeg(105)]);
  degradedShape(degradedBoth, 'purchases on both cards');
  atMostTruth(degradedBoth, both([cashLeg(105, { notes: TRAVEL })]), 'both cards vs truth (Travel Visa)');
  atMostTruth(degradedBoth, both([cashLeg(105), cardCredit('card2', 105)]), 'both cards vs truth (second card)');
}

console.log('3. Same class, other shapes');
{
  degradedShape(run(world([purchase, cashLeg(60), cashLeg(45)])), 'two unconfirmed debits', { count: 2 });
  const later = run(world([purchase, cashLeg(105)], { minimumDate: '2026-09-28' }));
  degradedShape(later, 'minimum due later');
  atMostTruth(later, run(world([purchase, cashLeg(105, { notes: TRAVEL })], { minimumDate: '2026-09-28' })), 'minimum later vs truth');
  const fromSavings = run(world([purchase, cashLeg(105, {}, 'savings')], { reserveSavings: true, savingsOpening: 300 }));
  degradedShape(fromSavings, 'a Savings debit to an unknown card', { from: 'savings', cashFigures: false });
  const savingsResolved = run(world([purchase, cashLeg(105, { notes: TRAVEL }, 'savings')], { reserveSavings: true, savingsOpening: 300 }));
  check(fromSavings.period.fromTodayFunding.availableNow === undefined && savingsResolved.period.fromTodayFunding.availableNow === undefined,
    'Savings debit: today\'s cash stays withheld by the Savings-movement cutoff, confirmed or not (unchanged)');
  check(fromSavings.coverage.reservedCash === 80, 'Savings debit: the purchase stays reserved');
  const reserveWorld = run(world([purchase, cashLeg(105)], { reserveSavings: true, savingsOpening: 300 }));
  degradedShape(reserveWorld, 'Bills debit, reserve Savings world');
  check(reserveWorld.advice.savingsFunding.period.trust === 'estimated'
    && reserveWorld.advice.savingsFunding.moneyMovementPermission === 'not-granted',
  'Savings planning is estimated and grants no money movement');
  atMostTruth(reserveWorld, run(world([purchase, cashLeg(105, { notes: TRAVEL })], { reserveSavings: true, savingsOpening: 300 })),
    'reserve world vs truth');
}

console.log('4. Still withheld, exactly as before');
{
  // Money back INTO Bills from an unknown card (a reversed payment, say),
  // filed as a card payment: ignoring it could leave a purchase looking covered.
  const credit = run(world([purchase, ['bills', -105, null, 'cash']]));
  check(credit.coverage.status === 'unavailable' && credit.coverage.trust === undefined
    && codes(credit).includes('coverage-payment-destination-unconfirmed'), 'an unpaired credit into Bills still withholds');
  check(credit.period.fromTodayFunding.availableNow === null, 'and available now stays withheld');
  // Beside any other card issue, the destination withholds with it.
  const other = run(world([purchase, cashLeg(105), ['card', 30, null, 'purchase', { is_pending: null }]]));
  check(other.coverage.status === 'unavailable' && codes(other).includes('coverage-payment-destination-unconfirmed')
    && codes(other).length > 1 && other.coverage.trust === undefined, 'beside another card issue: withheld, both listed');
  // A debit out of Weekly: its cash was already counted against the household
  // hold through the Bills-to-Weekly funding, so ignoring it is not proven
  // cautious. It withholds as before.
  const weekly = run(world([purchase, cashLeg(105, {}, 'weekly')]));
  check(weekly.coverage.status === 'unavailable' && weekly.coverage.trust === undefined
    && codes(weekly).includes('coverage-payment-destination-unconfirmed'), 'an unpaired Weekly debit still withholds');
  // A pending debit is not a payment yet: as before, it adds nothing.
  const pending = run(world([purchase, cashLeg(105, { is_pending: true })]));
  check(!codes(pending).includes('coverage-payment-destination-unconfirmed') && pending.coverage.trust === undefined,
    'a pending debit is not an unconfirmed payment');
}

console.log('5. Resolves exactly as today');
{
  const noted = run(world([purchase, cashLeg(105, { notes: TRAVEL })]));
  check(noted.coverage.toConfirm === undefined && noted.period.fromTodayFunding.trust === 'calculated',
    'a note names the card: no To-confirm row, calculated as today');
  const credited = run(world([purchase, cashLeg(105), cardCredit('card', 105)]));
  check(credited.coverage.trust === undefined && credited.coverage.reservedCash === 0, 'its card credit pairs it: calculated as today');
}

console.log('6. No tag moves toward certainty');
{
  // Baseline: today's behaviour, the withheld twin (the same world with the
  // unpaired leg a card-payment credit back into Bills, section 4), which
  // withholds every figure built on card coverage. Where both runs carry a
  // graded tag, the estimate is never more certain; where today's tag is
  // unknown or unavailable and a figure is now published, it is estimated.
  const withheld = run(world([purchase, ['bills', -105, null, 'cash']]));
  const td = tags(degraded.advice), tw = tags(withheld.advice);
  let newlyPublished = 0;
  for (const [k, v] of Object.entries(td)) {
    if (!(k in tw) || !(v in RANK)) continue;
    if (tw[k] in RANK) check(RANK[v] <= RANK[tw[k]], `${k}: ${v} is no more certain than today's ${tw[k]}`);
    else { newlyPublished++; check(v === 'estimated', `${k}: today ${tw[k]}, now ${v} (estimated at most)`); }
  }
  check(newlyPublished >= 5, `the audit reached the card-dependent figures (${newlyPublished})`);
}

console.log(`\nAll card-payment destination estimate checks passed (${checks}).`);
