'use strict';
// Dale's direction (lead dispatch 2026-11-18, stop 2): one card credit whose
// purpose Atlas cannot confirm (a payment or a refund) never takes the plan
// down. A POSTED credit on a mapped card that is neither a ruled refund, a
// ruled TD rewards redemption nor a paired card payment is counted as NEITHER:
// it covers no purchase and pays no minimum, so every card purchase stays
// reserved as if unpaid. That can only understate the money left: a refund
// would release a purchase from the reserve and a payment would cover the
// minimum and purchases, and a credit moves no household cash. The plan stays
// live, the credit is one "To confirm: was this card credit a payment or a
// refund?" row, and every figure built on the card coverage carries an
// estimated tag (the #1358 machinery). A pending credit, or the credit beside
// any other card issue, withholds exactly as before. Invented numbers only;
// every expected figure is hand-derived.
//
// World (test/fixtures/card-coverage-aggregate-world.js): payday anchor
// 2026-09-18, Bills 500, Travel Visa debt 400, groceries allowance 150, a 25
// Travel Visa minimum due on the as-of 2026-09-20, one 80 grocery purchase on
// Travel Visa. Bills is not touched by the credit, so it stays 500.
//
// Hand-derived, a posted 30 Travel Visa credit described "Invented credit"
// in "Payment, Transfer":
//   degraded (counted as neither): 500 - 80 purchase reserve - 70 groceries
//     left - 25 minimum = 325 available now;
//   truth A, a known non-payment credit (a ruled rewards redemption): the
//     same 325, so the estimate is tight there;
//   truth B, a refund of the grocery purchase: the reserve falls to 50, so
//     500 - 50 - 70 - 25 = 355;
//   a payment can only cover the minimum or a purchase, raising the figure.
// So 325 <= every truth.
const assert = require('node:assert/strict');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };
const BASIS = 'card-credit-purpose-unconfirmed';
const QUESTION = 'To confirm: was this card credit a payment or a refund?';
const transfer = { category_name: 'Payment, Transfer' };
const purchase = ['card', 80, null, 'purchase'];
// The unconfirmed credit, and the same row as each truth.
const unknown = (amount = 30, extra = {}, account = 'card') => [account, -amount, null, 'credit',
  { payee: 'Invented credit', original_name: 'Invented credit', ...transfer, ...extra }];
const asNonPayment = (amount = 30, account = 'card') => [account, -amount, null, 'credit',
  { payee: 'Invented rewards', original_name: 'REWARDS REDEMPTION', ...transfer }];
const asRefund = (amount = 30, account = 'card') => [account, -amount, null, 'refund'];
const cashLeg = (amount, extra = {}) => ['bills', amount, null, 'cash',
  { payee: 'AB123 TFR-TO C/C', original_name: 'AB123 TFR-TO C/C', category_name: 'Transfer', ...extra }];
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
const degradedShape = (s, why, { amount = 30, count = 1, basis = BASIS } = {}) => {
  check(s.observed.data.liveOverlay.operatingPlan === 'live', why + ': the plan stays live');
  check(s.coverage.status === 'ready' && codes(s).length === 0, why + ': coverage published, no withholding issue');
  check(s.coverage.trust === 'estimated' && s.coverage.estimateBasis === basis, why + ': coverage is an estimate, basis ' + basis);
  const rows = s.coverage.toConfirm.filter(r => r.basis === BASIS);
  check(rows.length === count && rows.every(r => r.question === QUESTION), why + ': one To-confirm row per credit');
  if (count === 1) check(rows[0].amount === amount && typeof rows[0].onCard === 'string' && rows[0].onCard.length > 0
    && rows[0].fromAccount === undefined, why + ': the row names the amount and the card, no household account');
  check(s.coverage.payments.length === 0 || s.coverage.payments.every(p => p.amount !== amount || p.status !== 'reconciled'),
    why + ': the credit is no payment');
  const f = s.period.fromTodayFunding;
  check(f.availableNow != null && f.trust === 'estimated', why + ': available now is published and estimated');
  check(s.period.plannedPeriodClose != null && s.period.plannedPeriodCloseTrust === 'estimated', why + ': the close is estimated');
  const pa = s.advice.paydayAllocation;
  check(pa.paydayShellTrust.available === 'estimated' && pa.paydayShellTrust.household === 'estimated',
    why + ': payday available and household allowance are estimated');
  check(pa.extraDebt.status === 'unavailable' && pa.extraDebt.allocated == null && pa.movable == null
    && pa.protectedPath.status === 'unavailable', why + ': money-moving proposals still wait');
  // Lead B2 on #1358: every projection walked forward at the (lower) cap is withheld.
  const a = s.advice;
  check(a.sim.endingSurplus === null && a.sim.extraDebtCapacity === null, why + ': the walk\'s surplus and debt capacity are withheld');
  check(a.planSpendPaydayFunding.status === 'unavailable' && a.planSpendPaydayFunding.paydays.length === 0,
    why + ': the payday funding schedule is withheld');
};

console.log('1. The case: one posted 30 Travel Visa credit of unknown purpose');
const degraded = run(world([purchase, unknown()]));
degradedShape(degraded, 'unknown credit');
check(degraded.period.fromTodayFunding.availableNow === 325, 'available now is the hand-derived 325 (got '
  + degraded.period.fromTodayFunding.availableNow + ')');
check(degraded.coverage.reservedCash === 80, 'the 80 purchase stays reserved as if unpaid');
check(degraded.period.householdBudget[0].spent === 80, 'groceries spent stays 80: the credit is no refund');
check(/neither/.test(degraded.coverage.estimateReason) && /neither/.test(degraded.period.plannedPeriodCloseReason || ''),
  'the coverage and the close each say the credit is counted as neither');

console.log('2. Never above the truth, whatever the credit was');
{
  const nonPayment = run(world([purchase, asNonPayment()]));
  check(nonPayment.coverage.status === 'ready' && nonPayment.coverage.trust === undefined
    && nonPayment.period.fromTodayFunding.availableNow === 325, 'truth A (a known non-payment credit): 325, calculated');
  atMostTruth(degraded, nonPayment, 'vs truth A (non-payment)');
  check(JSON.stringify(moneyLeft(degraded)) === JSON.stringify(moneyLeft(nonPayment)),
    'the estimate equals the non-payment truth: tight there');
  const refund = run(world([purchase, asRefund()]));
  check(refund.coverage.status === 'ready' && refund.coverage.trust === undefined && refund.coverage.reservedCash === 50
    && refund.period.fromTodayFunding.availableNow === 355, 'truth B (a refund of the purchase): reserve 50, 355');
  atMostTruth(degraded, refund, 'vs truth B (refund)');
  // A credit larger than the purchase, and a minimum due later.
  atMostTruth(run(world([purchase, unknown(120)])), run(world([purchase, asRefund(120)])), '120 credit vs refund');
  atMostTruth(run(world([purchase, unknown(120)])), run(world([purchase, asNonPayment(120)])), '120 credit vs non-payment');
  const later = run(world([purchase, unknown()], { minimumDate: '2026-09-28' }));
  degradedShape(later, 'minimum due later');
  atMostTruth(later, run(world([purchase, asRefund()], { minimumDate: '2026-09-28' })), 'minimum later vs refund');
}

console.log('3. Same class, other shapes');
{
  degradedShape(run(world([purchase, unknown(20), unknown(10)])), 'two unknown credits', { count: 2 });
  // On the second card: its own purchase stays reserved too.
  const two = run(world([purchase, ['card2', 40, null, 'purchase'], unknown(30, {}, 'card2')], { twoCards: true }));
  degradedShape(two, 'a credit on the second card');
  check(two.coverage.reservedCash === 120, 'both purchases stay reserved (80 + 40)');
  atMostTruth(two, run(world([purchase, ['card2', 40, null, 'purchase'], asRefund(30, 'card2')], { twoCards: true })),
    'second card vs refund');
  // Beside an unconfirmed payment destination (#1358): both are To confirm,
  // under the combined basis. Bills 500 - 105 = 395; 395 - 80 - 70 - 25 = 220.
  const both = run(world([purchase, cashLeg(105), unknown()]));
  degradedShape(both, 'beside an unconfirmed payment', { basis: 'card-coverage-rows-unconfirmed' });
  check(both.coverage.toConfirm.length === 2 && both.coverage.toConfirm.some(r => r.basis === 'card-payment-destination-unconfirmed'),
    'two rows: the payment and the credit');
  check(both.period.fromTodayFunding.availableNow === 220, 'available now 220 (got ' + both.period.fromTodayFunding.availableNow + ')');
  atMostTruth(both, run(world([purchase, cashLeg(105, { notes: TRAVEL }), asRefund()])), 'both vs paid Travel Visa and a refund');
  atMostTruth(both, run(world([purchase, cashLeg(105, { notes: TRAVEL }), asNonPayment()])), 'both vs paid Travel Visa, non-payment');
  // A reserve-Savings world: savings planning is estimated, no money movement.
  const reserveWorld = run(world([purchase, unknown()], { reserveSavings: true, savingsOpening: 300 }));
  degradedShape(reserveWorld, 'reserve Savings world');
  check(reserveWorld.advice.savingsFunding.period.trust === 'estimated'
    && reserveWorld.advice.savingsFunding.moneyMovementPermission === 'not-granted',
  'Savings planning is estimated and grants no money movement');
  atMostTruth(reserveWorld, run(world([purchase, asRefund()], { reserveSavings: true, savingsOpening: 300 })), 'reserve world vs refund');
}

console.log('4. Still withheld, exactly as before');
{
  const pending = run(world([purchase, unknown(30, { is_pending: true })]));
  check(pending.coverage.status === 'unavailable' && pending.coverage.trust === undefined
    && codes(pending).includes('coverage-payment-or-credit-purpose-unconfirmed'), 'a pending credit still withholds');
  check(pending.period.fromTodayFunding.availableNow === null, 'and available now stays withheld');
  const other = run(world([purchase, unknown(), ['card', 30, null, 'purchase', { is_pending: null }]]));
  check(other.coverage.status === 'unavailable' && codes(other).includes('coverage-payment-or-credit-purpose-unconfirmed')
    && codes(other).length > 1 && other.coverage.trust === undefined, 'beside another card issue: withheld, both listed');
  // Beside an issue that still withholds (an unpaired credit back into Bills),
  // both codes are listed and nothing is estimated.
  const intoBills = run(world([purchase, ['bills', -105, null, 'cash'], unknown()]));
  check(intoBills.coverage.status === 'unavailable' && codes(intoBills).includes('coverage-payment-or-credit-purpose-unconfirmed')
    && codes(intoBills).includes('coverage-payment-destination-unconfirmed') && intoBills.coverage.toConfirm === undefined,
  'beside a credit into Bills: withheld, both listed, no To-confirm rows');
}

console.log('5. Resolves exactly as today');
{
  const ruled = run(world([purchase, asNonPayment()]));
  check(ruled.coverage.toConfirm === undefined && ruled.period.fromTodayFunding.trust === 'calculated',
    'a ruled non-payment credit: no To-confirm row, calculated as today');
  const refund = run(world([purchase, asRefund()]));
  check(refund.coverage.toConfirm === undefined && refund.coverage.reservedCash === 50, 'a refund: calculated as today');
  const none = run(world([purchase]));
  check(none.coverage.trust === undefined && none.period.fromTodayFunding.availableNow === 325, 'no credit at all: 325, calculated');
}

console.log('6. No tag moves toward certainty');
{
  // Baseline: today's behaviour, the withheld twin (the same credit pending),
  // which withholds every figure built on card coverage.
  const withheld = run(world([purchase, unknown(30, { is_pending: true })]));
  const resolved = run(world([purchase, asNonPayment()]));
  const td = tags(degraded.advice), tw = tags(withheld.advice), tr = tags(resolved.advice);
  let newlyPublished = 0;
  for (const [k, v] of Object.entries(td)) {
    if (!(v in RANK)) continue;
    if (!(k in tw)) {
      if (!(tr[k] in RANK)) { newlyPublished++; check(v === 'estimated', `${k}: absent today, now ${v} (estimated at most)`); }
      continue;
    }
    if (tw[k] in RANK) check(RANK[v] <= RANK[tw[k]], `${k}: ${v} is no more certain than today's ${tw[k]}`);
    else { newlyPublished++; check(v === 'estimated', `${k}: today ${tw[k]}, now ${v} (estimated at most)`); }
  }
  check(newlyPublished >= 5, `the audit reached the card-dependent figures (${newlyPublished})`);
  // Every tag the estimate carries is no more certain than the resolved truth's.
  for (const [k, v] of Object.entries(td)) if (v in RANK && tr[k] in RANK)
    check(RANK[v] <= RANK[tr[k]], `${k}: ${v} is no more certain than the resolved ${tr[k]}`);
}

console.log('7. The Budget payment section shows the To-confirm row');
{
  const Detail = require('../public/bill-detail');
  const html = Detail.visaPaymentsHtml(degraded.period.visaPaymentBackfill, degraded.period.cardPurchaseCoverage);
  check((html.match(/data-card-payment-to-confirm-row/g) || []).length === 1, 'one To-confirm row on the page');
  check(html.includes(QUESTION) && html.includes('2026-09-20') && html.includes('$30.00') && / · on [^<]+</.test(html)
    && !html.includes(' · from '), 'it shows the question, date, amount and the card, not a household account');
  check(/counts toward no card/.test(html) && /estimates/.test(html), 'it says the row counts toward no card and the figures are estimates');
  check(/data-card-payment-to-confirm data-trust="estimated"/.test(html), 'the block is tagged as an estimate');
  const planted = { ...degraded.period.cardPurchaseCoverage, toConfirm: [{ basis: BASIS, question: '<img src=x onerror=alert(1)>',
    date: '2026-09-20', amount: 30, onCard: '<b>x</b>' }] };
  const escaped = Detail.visaPaymentsHtml([], planted);
  check(!escaped.includes('<img') && !escaped.includes('<b>') && escaped.includes('&lt;img') && escaped.includes('&lt;b&gt;'),
    'every printed string, the card name included, is escaped');
  const both = run(world([purchase, cashLeg(105), unknown()]));
  const bothHtml = Detail.visaPaymentsHtml(both.period.visaPaymentBackfill, both.period.cardPurchaseCoverage);
  check((bothHtml.match(/data-card-payment-to-confirm-row/g) || []).length === 2 && bothHtml.includes('from Bills')
    && bothHtml.includes(QUESTION), 'beside a payment: two rows, each in its own words');
  const ruled = run(world([purchase, asNonPayment()]));
  check(!/data-card-payment-to-confirm/.test(Detail.visaPaymentsHtml(ruled.period.visaPaymentBackfill, ruled.period.cardPurchaseCoverage)),
    'once its purpose is known, no To-confirm row');
}

console.log('8. The assistant packet: forward walks withheld, the rest estimated, this basis named');
{
  const Live = require('../scripts/live-plan');
  const Assistant = require('../scripts/assistant-packet');
  const packetOf = rows => Assistant.buildPacket({ data: Live.fromObservation(world(rows)).data, periods: null, questionsMarkdown: '' });
  const p = packetOf([purchase, unknown()]);
  const est = o => o && o.cardCoverageEstimate && o.cardCoverageEstimate.basis === BASIS
    && o.cardCoverageEstimate.toConfirmCount === 1 && /neither/.test(o.cardCoverageEstimate.reason);
  check(p.planning.trajectory.status === 'unavailable' && est(p.planning.trajectory), 'the monthly trajectory is withheld, disclosed');
  check(p.forecast.horizon.minBalance === null && p.forecast.horizon.minDate === null, 'the projected low point is withheld');
  check(p.forecast.facilityCrossings.status === 'unavailable' && est(p.forecast.facilityCrossings), 'facility crossings are withheld');
  check(p.forecast.trust === 'estimated' && est(p.forecast), 'the forecast block is estimated, this basis named');
  check(p.forecast.currentPeriodAction.trust === 'estimated', 'currentPeriodAction is tagged estimated');
  check(!JSON.stringify(p).includes('Invented credit') && !/coverageRef/.test(JSON.stringify(p.forecast)),
    'no provider description or reference reaches the packet');
  const flat = (o, pre = '', m = {}) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
    if (v === null || typeof v !== 'object') m[pre + k] = v; else flat(v, pre + k + '.', m); } return m; };
  const fd = flat(p), fw = flat(packetOf([purchase, unknown(30, { is_pending: true })]));
  let graded = 0;
  for (const [k, v] of Object.entries(fd)) {
    if (!/(trust|Trust)$/.test(k) || !(v in RANK)) continue;
    if (fw[k] in RANK) check(RANK[v] <= RANK[fw[k]], `packet ${k}: ${v} no more certain than today's ${fw[k]}`);
    else { graded++; check(v === 'estimated', `packet ${k}: today ${fw[k]}, now ${v} (estimated at most)`); }
  }
  check(graded >= 3, `the packet audit reached the newly published sections (${graded})`);
  for (const truthRows of [[purchase, asRefund()], [purchase, asNonPayment()]]) {
    const ft = flat(packetOf(truthRows));
    for (const [k, v] of Object.entries(fd)) {
      if (typeof v !== 'number' || typeof ft[k] !== 'number' || /At$|asOf|Count$|days|Days/i.test(k)) continue;
      // What a bill row still owes may only be overstated (H2-9: a covered minimum owes 0 in the truth).
      if (/^forecast\.currentPeriodAction\.bills\.\d+\.remaining$/.test(k)) { check(v >= ft[k] - 0.005, `packet ${k}: ${v} >= truth ${ft[k]}`); continue; }
      check(v <= ft[k] + 0.005, `packet ${k}: ${v} <= truth ${ft[k]}`);
    }
  }
  const combined = packetOf([purchase, cashLeg(105), unknown()]);
  check(combined.forecast.cardCoverageEstimate.basis === 'card-coverage-rows-unconfirmed'
    && combined.forecast.cardCoverageEstimate.toConfirmCount === 2, 'beside a payment: the combined basis and two rows');
}

console.log('9. Every published figure on the cautious side of the truth');
{
  const Live = require('../scripts/live-plan');
  const Snapshot = require('../scripts/figures-snapshot');
  const snapOf = (rows, opts) => { const o = Live.fromObservation(world(rows, opts)); return Snapshot.buildFiguresSnapshot(o.data, o.data.periods || null); };
  // Higher is the cautious direction for these: what is still owed or reserved.
  const CAUTIOUS = [/^totals\.obligations$/, /^payday\.obligations$/, /^period\.[^.]+\.remainingBills$/, /reserve/i, /[Rr]equired/, /[Ss]hortfall/,
    /[Cc]onsumerDebt/, /^balance\.debts$/, /^revolving\.[^.]+\.(posted|used)$/];
  // The single named pre-existing exception (#1358, lead's call): the Plan
  // tab's raw walk, drawn only inside the hidden, inert #road-ahead (#1365).
  const MIN_CAUTIOUS = 20;
  const RAW_WALK = [/^plan\.endingCash$/, /^plan\.lowestCash$/, /^plan\.bindingBalance$/];
  const compare = (degradedRows, truthRows, opts, why) => {
    const d = snapOf(degradedRows, opts), t = snapOf(truthRows, opts);
    let compared = 0, cautious = 0;
    for (const [k, v] of Object.entries(d)) {
      if (typeof v !== 'number' || typeof t[k] !== 'number') continue;
      if (RAW_WALK.some(re => re.test(k))) continue;
      // What is still owed or reserved may only be overstated.
      if (CAUTIOUS.some(re => re.test(k))) {
        cautious++;
        check(v >= t[k] - 0.005, `${why}: published ${k} ${v} >= truth ${t[k]}`);
        continue;
      }
      compared++;
      check(v <= t[k] + 0.005, `${why}: published ${k} ${v} <= truth ${t[k]}`);
    }
    check(compared >= 20, `${why}: compared ${compared} published figures`);
    check(cautious >= MIN_CAUTIOUS, `${why}: compared ${cautious} cautious figures`);
  };
  compare([purchase, unknown()], [purchase, asNonPayment()], {}, 'vs non-payment');
  compare([purchase, unknown()], [purchase, asRefund()], {}, 'vs refund');
  const two = [purchase, ['card2', 40, null, 'purchase']];
  compare([...two, unknown(30, {}, 'card2')], [...two, asRefund(30, 'card2')], { twoCards: true }, 'second card vs refund');
  compare([purchase, cashLeg(105), unknown()], [purchase, cashLeg(105, { notes: TRAVEL }), asRefund()], {}, 'combined vs paid and refund');
}

console.log('10. The operating answer names the estimate on its spending permission');
{
  const Live = require('../scripts/live-plan');
  const OA = require('../scripts/operating-answer');
  const answer = OA.fromRefreshedState(Live.fromObservation(world([purchase, unknown()])).data, { mode: 'live-overlay' });
  const permission = answer.currentSpendingPermission;
  check(permission && permission.trust === 'estimated' && permission.estimateBasis === BASIS
    && permission.toConfirmCount === 1, 'currentSpendingPermission is tagged estimated with its basis and count');
  const resolved = OA.fromRefreshedState(Live.fromObservation(world([purchase, asNonPayment()])).data, { mode: 'live-overlay' });
  check(resolved.currentSpendingPermission.trust === undefined, 'resolved: no estimate tag, as today');
}

console.log(`\nAll card-credit purpose estimate checks passed (${checks}).`);
