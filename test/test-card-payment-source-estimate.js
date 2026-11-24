'use strict';
// Dale's direction (lead dispatch 2026-11-18, stop 2): one card payment whose
// SOURCE Atlas cannot confirm never takes the plan down. A POSTED card
// payment credit (the issuer's "PAYMENT - THANK YOU") with no household cash
// leg near it (same cents within the pairing window) counts toward NO card:
// it covers no purchase and pays no minimum, so every card purchase stays
// reserved as if unpaid. It moves no household cash, so the figures equal a
// world without the credit; a real payment, from anywhere, or a refund could
// only cover more. The plan stays live, the credit is one "To confirm: where
// did this card payment come from?" row, and every figure built on card
// coverage carries an estimated tag (the #1358 machinery). A near cash leg
// that cannot pair (contradicting evidence), or any other card issue, still
// withholds; a pending credit withholds exactly as before. Invented numbers
// only; every expected figure is hand-derived.
//
// World (test/fixtures/card-coverage-aggregate-world.js): payday anchor
// 2026-09-18, Bills 500, Travel Visa debt 400, groceries allowance 150, a 25
// Travel Visa minimum due on the as-of 2026-09-20, one 80 grocery purchase.
//
// Hand-derived, a posted 105 PAYMENT - THANK YOU credit, no cash leg:
//   degraded (counts toward no card): 500 - 80 purchase reserve - 70
//     groceries left - 25 minimum = 325, the same as with no credit at all;
//   truth, a refund of the purchase: reserve 0, so 500 - 0 - 175 - 25 = 300;
//   truth, a payment from outside the household: the minimum and the
//     purchase covered, 500 - 70 = 430 (no constructible world: hand only).
// Section 2 pins the pre-existing 325 > 300 gap for the oversize linked refund.
const assert = require('node:assert/strict');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };
const BASIS = 'card-payment-source-unconfirmed';
const QUESTION = 'To confirm: where did this card payment come from?';
const purchase = ['card', 80, null, 'purchase'];
const credit = (amount = 105, extra = {}, account = 'card') => [account, -amount, null, 'credit',
  { payee: 'PAYMENT - THANK YOU', original_name: 'PAYMENT - THANK YOU', category_name: 'Transfer', ...extra }];
const asRefund = (amount = 105, account = 'card') => [account, -amount, null, 'refund', { is_group_parent: true }];
const cashLeg = (amount, extra = {}, date = null) => ['bills', amount, date, 'cash',
  { payee: 'AB123 TFR-TO C/C', original_name: 'AB123 TFR-TO C/C', category_name: 'Transfer', ...extra }];
const codes = s => (s.coverage.issues || []).map(i => i.code);

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
function checkMoneyLeftBounds(d, t, why) {
  for (const [k, v] of Object.entries(d)) {
    if (v == null) continue;
    check(t[k] != null, `${why}: ${k} is published in the truth case too`);
    check(v <= t[k] + 1e-9, `${why}: ${k} ${v} <= truth ${t[k]}`);
  }
}
function atMostTruth(degraded, truth, why) {
  checkMoneyLeftBounds(moneyLeft(degraded), moneyLeft(truth), why);
  check(degraded.coverage.reservedCash >= truth.coverage.reservedCash,
    `${why}: reserve ${degraded.coverage.reservedCash} >= truth ${truth.coverage.reservedCash}`);
}
// NEXT PR (#1618 pre-review, item 4): cap the from-today remainder at the hold (forecast.js:23606)
// and restore atMostTruth at both call sites. On main, spent -25 gives a remainder of 175 on a 150 hold.
function checkOversizeRefundGap(estimate, linked, why) {
  const { availableNow: estimatedNow, ...otherEstimated } = moneyLeft(estimate);
  const { availableNow: linkedNow, ...otherLinked } = moneyLeft(linked);
  assert.deepEqual([estimatedNow, linkedNow, estimate.coverage.reservedCash, linked.coverage.reservedCash],
    [325, 300, 80, 0], why + ': known oversize gap, unidentified vs linked 105, available cash and reserve');
  checkMoneyLeftBounds(otherEstimated, otherLinked, why);
}
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
const degradedShape = (s, why, { amount = 105, count = 1, basis = BASIS } = {}) => {
  check(s.observed.data.liveOverlay.operatingPlan === 'live', why + ': the plan stays live');
  check(s.coverage.status === 'ready' && codes(s).length === 0, why + ': coverage published, no withholding issue');
  check(s.coverage.trust === 'estimated' && s.coverage.estimateBasis === basis, why + ': coverage is an estimate, basis ' + basis);
  const rows = s.coverage.toConfirm.filter(r => r.basis === BASIS);
  check(rows.length === count && rows.every(r => r.question === QUESTION && typeof r.onCard === 'string' && r.onCard.length > 0
    && r.fromAccount === undefined), why + ': one To-confirm row per credit, naming the card');
  if (count === 1) check(rows[0].amount === amount, why + ': the row names the amount');
  check(!s.coverage.payments.some(p => p.status === 'reconciled' && p.amount === amount), why + ': the credit pays no card');
  const f = s.period.fromTodayFunding;
  check(f.availableNow != null && f.trust === 'estimated' && f.estimateCause === 'card-coverage',
    why + ': available now is published and estimated, card coverage its only cause');
  check(s.period.plannedPeriodClose != null && s.period.plannedPeriodCloseTrust === 'estimated', why + ': the close is estimated');
  const pa = s.advice.paydayAllocation;
  check(pa.paydayShellTrust.available === 'estimated' && pa.extraDebt.status === 'unavailable' && pa.movable == null
    && pa.protectedPath.status === 'unavailable', why + ': payday available estimated; money-moving proposals wait');
  const a = s.advice;
  check(a.sim.endingSurplus === null && a.sim.extraDebtCapacity === null
    && a.planSpendPaydayFunding.status === 'unavailable', why + ': the forward walks (lead B2 on #1358) are withheld');
};

console.log('1. The case: one posted 105 PAYMENT - THANK YOU credit, no cash leg');
const degraded = run(world([purchase, credit()]));
const noCredit = run(world([purchase]));
degradedShape(degraded, 'unsourced credit');
check(degraded.period.fromTodayFunding.availableNow === 325, 'available now is the hand-derived 325 (got '
  + degraded.period.fromTodayFunding.availableNow + ')');
check(degraded.coverage.reservedCash === 80, 'the 80 purchase stays reserved as if unpaid');
// The negative (#1573): beside this To-confirm credit, a non-card estimate (the invented payroll estimated) reads as
// non-card: no card cause. The card-coverage cause above stands only while the cards are the only uncertainty.
{
  const incomeEstimated = run(world([purchase, credit()], { edit: w => { w.data.plan.income[0].confidence = 'estimated'; } }));
  check(incomeEstimated.coverage.trust === 'estimated' && incomeEstimated.period.fromTodayFunding.trust === 'estimated'
    && incomeEstimated.period.fromTodayFunding.estimateCause === undefined, 'an estimated income beside it: estimated, no card cause');
}
check(/source|came from/.test(degraded.coverage.estimateReason) && /source/.test(degraded.period.plannedPeriodCloseReason || ''),
  'the coverage and close reasons name the unconfirmed source');

console.log('2. Payment-source bounds and the known oversize linked-refund gap');
{
  check(noCredit.coverage.trust === undefined && noCredit.period.fromTodayFunding.availableNow === 325, 'no credit: 325, calculated');
  check(JSON.stringify(moneyLeft(degraded)) === JSON.stringify(moneyLeft(noCredit)), 'every money-left figure equals the no-credit world');
  atMostTruth(degraded, noCredit, 'vs no credit');
  const standalone = run(world([purchase, ['card', -105, null, 'refund']]));
  assert.deepEqual([standalone.period.fromTodayFunding.availableNow, standalone.coverage.reservedCash], [325, 80]);
  atMostTruth(degraded, standalone, '105 credit vs standalone refund');
  const rewards = run(world([purchase, credit(105, { payee: 'Invented rewards', original_name: 'REWARDS REDEMPTION' })]));
  check(rewards.coverage.status === 'ready' && rewards.coverage.toConfirm === undefined, 'known non-payment credit');
  atMostTruth(degraded, rewards, '105 credit vs rewards redemption');
  const linked80 = run(world([purchase, asRefund(80)]));
  assert.deepEqual([linked80.period.fromTodayFunding.availableNow, linked80.coverage.reservedCash], [325, 0]);
  atMostTruth(run(world([purchase, credit(80)])), linked80, '80 credit vs linked refund equal to the purchase');
  checkOversizeRefundGap(degraded, run(world([purchase, asRefund()])), 'minimum due today');
  // A payment from outside the household would cover the minimum and the
  // purchase: hand-derived 430, above the estimate.
  check(degraded.period.fromTodayFunding.availableNow <= 430, 'below the hand-derived outside-payment truth 430');
  const later = run(world([purchase, credit()], { minimumDate: '2026-09-28' }));
  degradedShape(later, 'minimum due later');
  atMostTruth(later, run(world([purchase], { minimumDate: '2026-09-28' })), 'minimum later vs no credit');
  checkOversizeRefundGap(later, run(world([purchase, asRefund()], { minimumDate: '2026-09-28' })), 'minimum due later');
}

console.log('3. Same class, other shapes');
{
  degradedShape(run(world([purchase, credit(60), credit(45)])), 'two unsourced credits', { count: 2, amount: 60 });
  // On a non-TD card the TD "PAYMENT - THANK YOU" wording is no payment
  // identity (it is #1367's purpose case); the fixture's own card-payment
  // credit, filed under Credit Card Payment, is.
  const two = run(world([purchase, ['card2', 40, null, 'purchase'], ['card2', -40, null, 'credit']], { twoCards: true }));
  degradedShape(two, 'on the second card', { amount: 40 });
  check(two.coverage.reservedCash === 120, 'both purchases stay reserved (80 + 40)');
  atMostTruth(two, run(world([purchase, ['card2', 40, null, 'purchase']], { twoCards: true })), 'second card vs no credit');
  // A debit and a credit a cent apart never pair: both To confirm (#1358).
  // Bills 500 - 105 = 395; 395 - 80 - 70 - 25 = 220.
  const apart = run(world([purchase, cashLeg(105), credit(104.99)]));
  degradedShape(apart, 'a cent apart from a debit', { amount: 104.99, basis: 'card-coverage-rows-unconfirmed' });
  check(apart.coverage.toConfirm.length === 2 && apart.period.fromTodayFunding.availableNow === 220,
    'a cent apart: two rows, available now 220 (got ' + apart.period.fromTodayFunding.availableNow + ')');
  atMostTruth(apart, run(world([purchase, cashLeg(105), credit(105)])), 'a cent apart vs paired');
  // Beside an unconfirmed-purpose credit (#1367): the combined basis.
  const mixed = run(world([purchase, credit(), ['card', -30, null, 'credit',
    { payee: 'Invented credit', original_name: 'Invented credit', category_name: 'Payment, Transfer' }]]));
  degradedShape(mixed, 'beside a purpose credit', { basis: 'card-coverage-rows-unconfirmed' });
  const reserveWorld = run(world([purchase, credit()], { reserveSavings: true, savingsOpening: 300 }));
  degradedShape(reserveWorld, 'reserve Savings world');
  check(reserveWorld.advice.savingsFunding.period.trust === 'estimated'
    && reserveWorld.advice.savingsFunding.moneyMovementPermission === 'not-granted',
  'Savings planning is estimated and grants no money movement');
}

console.log('4. Still withheld, or unchanged, exactly as before');
{
  // A near cash leg that cannot pair is contradicting evidence: withheld.
  const nonTd = run(world([purchase, ['bills', 105, null, 'cash', { payee: 'Invented card payment', category_name: 'Credit Card Payment' }], credit()]));
  check(nonTd.coverage.status === 'unavailable' && codes(nonTd).includes('coverage-payment-source-unconfirmed')
    && nonTd.coverage.trust === undefined, 'a near non-TD debit that cannot pair: withheld');
  const otherCard = run(world([purchase, cashLeg(105, { notes: 'card payment: TD Cash Back Visa ...9999' }), credit()]));
  check(otherCard.coverage.status === 'unavailable' && codes(otherCard).includes('coverage-payment-source-unconfirmed'),
    'a near debit whose note names another card: withheld');
  const other = run(world([purchase, credit(), ['card', 30, null, 'purchase', { is_pending: null }]]));
  check(other.coverage.status === 'unavailable' && codes(other).includes('coverage-payment-source-unconfirmed')
    && codes(other).length > 1 && other.coverage.toConfirm === undefined, 'beside another card issue: withheld, both listed');
  const intoBills = run(world([purchase, credit(), ['bills', -60, null, 'cash']]));
  check(intoBills.coverage.status === 'unavailable' && codes(intoBills).includes('coverage-payment-source-unconfirmed'),
    'beside a credit into Bills: withheld, both listed');
  // A pending one is no payment yet: it withholds exactly as on main.
  const pending = run(world([purchase, credit(105, { is_pending: true })]));
  check(pending.coverage.status === 'unavailable' && pending.coverage.trust === undefined
    && pending.coverage.toConfirm === undefined && pending.period.fromTodayFunding.availableNow === null,
  'a pending credit still withholds, with no To-confirm row');
}

console.log('5. Resolves exactly as today');
{
  const paired = run(world([purchase, cashLeg(105), credit()]));
  check(paired.coverage.trust === undefined && paired.coverage.toConfirm === undefined && paired.coverage.reservedCash === 0,
    'paired with its TFR-TO C/C debit: calculated, reserve 0');
  const unidentifiedDebit = cashLeg(105, { payee: 'Invented debit', original_name: 'Invented debit' });
  const unresolved = run(world([purchase, unidentifiedDebit, credit()]));
  check(unresolved.coverage.estimateBasis === BASIS, 'same debit amount with unknown source');
  atMostTruth(unresolved, paired, 'same debit and credit amounts, resolved as a payment');
}

console.log('6. No tag moves toward certainty');
{
  // Withheld twin: the same credit beside a hold that still withholds.
  const withheld = run(world([purchase, credit(), ['bills', -60, null, 'cash']]));
  const td = tags(degraded.advice), tw = tags(withheld.advice), tn = tags(noCredit.advice);
  let newlyPublished = 0;
  for (const [k, v] of Object.entries(td)) {
    if (!(v in RANK)) continue;
    if (!(k in tw)) {
      if (!(tn[k] in RANK)) { newlyPublished++; check(v === 'estimated', `${k}: absent today, now ${v} (estimated at most)`); }
      continue;
    }
    if (tw[k] in RANK) check(RANK[v] <= RANK[tw[k]], `${k}: ${v} is no more certain than today's ${tw[k]}`);
    else { newlyPublished++; check(v === 'estimated', `${k}: today ${tw[k]}, now ${v} (estimated at most)`); }
  }
  check(newlyPublished >= 5, `the audit reached the card-dependent figures (${newlyPublished})`);
  for (const [k, v] of Object.entries(td)) if (v in RANK && tn[k] in RANK)
    check(RANK[v] <= RANK[tn[k]], `${k}: ${v} is no more certain than the no-credit ${tn[k]}`);
}

console.log('7. The Budget payment section shows the To-confirm row');
{
  const Detail = require('../public/bill-detail');
  const html = Detail.visaPaymentsHtml(degraded.period.visaPaymentBackfill, degraded.period.cardPurchaseCoverage);
  check((html.match(/data-card-payment-to-confirm-row/g) || []).length === 1, 'one To-confirm row on the page');
  check(html.includes(QUESTION) && html.includes('$105.00') && / · on [^<]+</.test(html) && !html.includes(' · from '),
    'it shows the question, amount and the card, not a household account');
  check(/data-card-payment-to-confirm data-trust="estimated"/.test(html), 'the block is tagged as an estimate');
  const planted = { ...degraded.period.cardPurchaseCoverage, toConfirm: [{ basis: BASIS, question: '<img src=x onerror=alert(1)>',
    date: '2026-09-20', amount: 105, onCard: '<b>x</b>' }] };
  const escaped = Detail.visaPaymentsHtml([], planted);
  check(!escaped.includes('<img') && !escaped.includes('<b>') && escaped.includes('&lt;b&gt;'), 'every printed string is escaped');
}

console.log('8. The assistant packet and the operating answer name this basis');
{
  const Live = require('../scripts/live-plan');
  const Assistant = require('../scripts/assistant-packet');
  const OA = require('../scripts/operating-answer');
  const packetOf = rows => Assistant.buildPacket({ data: Live.fromObservation(world(rows)).data, periods: null, questionsMarkdown: '' });
  const p = packetOf([purchase, credit()]);
  const est = p.forecast.cardCoverageEstimate;
  check(p.forecast.trust === 'estimated' && est && est.basis === BASIS && est.toConfirmCount === 1 && /came from/.test(est.reason),
    'the packet forecast is estimated with this basis, its reason and the count');
  check(p.planning.trajectory.status === 'unavailable' && p.forecast.horizon.minBalance === null, 'the forward walks are withheld');
  check(!/PAYMENT - THANK YOU/.test(JSON.stringify(p)) && !/coverageRef/.test(JSON.stringify(p.forecast)),
    'no provider description or reference reaches the packet');
  const flat = (o, pre = '', m = {}) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
    if (v === null || typeof v !== 'object') m[pre + k] = v; else flat(v, pre + k + '.', m); } return m; };
  const fd = flat(p);
  // The no-credit world also lacks the credit in the card's provider
  // balance, so its provider-reported debt figures (available credit) differ
  // by input, not by card coverage; the withheld twin publishes the same
  // 1625 as the estimate. They are skipped against that truth only.
  check(fd['current.debts.totalAvailableCredit'] === flat(packetOf([purchase, credit(), ['bills', -60, null, 'cash']]))['current.debts.totalAvailableCredit'],
    'available credit is the provider figure: the same under the withheld twin');
  for (const [truthRows, skip] of [[[purchase], /^current\.debts\./], [[purchase, asRefund()], null]]) {
    const ft = flat(packetOf(truthRows));
    for (const [k, v] of Object.entries(fd)) {
      if (typeof v !== 'number' || typeof ft[k] !== 'number' || /At$|asOf|Count$|days|Days/i.test(k) || (skip && skip.test(k))) continue;
      check(v <= ft[k] + 0.005, `packet ${k}: ${v} <= truth ${ft[k]}`);
    }
  }
  const answer = OA.fromRefreshedState(Live.fromObservation(world([purchase, credit()])).data, { mode: 'live-overlay' });
  check(answer.currentSpendingPermission.trust === 'estimated' && answer.currentSpendingPermission.estimateBasis === BASIS
    && answer.currentSpendingPermission.toConfirmCount === 1, 'the operating answer names this basis and the count');
}

console.log('9. Every published figure, never above the truth');
{
  const Live = require('../scripts/live-plan');
  const Snapshot = require('../scripts/figures-snapshot');
  const snapOf = (rows, opts) => { const o = Live.fromObservation(world(rows, opts)); return Snapshot.buildFiguresSnapshot(o.data, o.data.periods || null); };
  const CAUTIOUS = [/^totals\.obligations$/, /^period\.[^.]+\.remainingBills$/, /reserve/i, /[Rr]equired/, /[Ss]hortfall/,
    /[Cc]onsumerDebt/, /^balance\.debts$/, /^revolving\.[^.]+\.(posted|used)$/];
  // The single named pre-existing exception (#1358): the Plan tab's raw walk,
  // drawn only inside the hidden, inert #road-ahead (#1365).
  const RAW_WALK = [/^plan\.endingCash$/, /^plan\.lowestCash$/, /^plan\.bindingBalance$/];
  const compare = (degradedRows, truthRows, opts, why) => {
    const d = snapOf(degradedRows, opts), t = snapOf(truthRows, opts);
    let compared = 0;
    for (const [k, v] of Object.entries(d)) {
      if (typeof v !== 'number' || typeof t[k] !== 'number') continue;
      if (CAUTIOUS.some(re => re.test(k)) || RAW_WALK.some(re => re.test(k))) continue;
      compared++;
      check(v <= t[k] + 0.005, `${why}: published ${k} ${v} <= truth ${t[k]}`);
    }
    check(compared >= 20, `${why}: compared ${compared} published figures`);
  };
  // Truths that keep the credit in the card's provider balance: removing it
  // would also change that balance (and so next period's card payment and
  // projected ending), an input difference rather than card coverage. The
  // refund truth keeps every input; it covers at least as much as a payment
  // of unknown source would release here, and a payment covers more.
  compare([purchase, credit()], [purchase, asRefund()], {}, 'vs refund');
  const two = [purchase, ['card2', 40, null, 'purchase']];
  compare([...two, ['card2', -40, null, 'credit']], [...two, asRefund(40, 'card2')], { twoCards: true }, 'second card vs refund');
  compare([purchase, credit(), credit(30)], [purchase, asRefund(), asRefund(30)], {}, 'two credits vs refunds');
}

console.log(`\nAll card-payment source estimate checks passed (${checks}).`);
