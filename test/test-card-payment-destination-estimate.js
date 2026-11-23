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
// Lead B2 on #1358: every projection that walks forward at the (lower) cap is withheld.
{
  const a = degraded.advice;
  check(a.sim.endingSurplus === null && a.sim.extraDebtCapacity === null, 'the walk\'s ending surplus and debt capacity are withheld');
  check(a.planSpendPaydayFunding.status === 'unavailable' && a.planSpendPaydayFunding.paydays.length === 0,
    'the payday funding schedule (walked at the cap) is withheld');
  const future = a.payPeriodViews.filter(v => v.start > degraded.period.start);
  check(future.length > 0 && future.every(v => v.plannedCostFunding && v.plannedCostFunding.status === 'unavailable'),
    'every later period\'s planned-cost funding is withheld');
  check(degraded.period.paydaySchedule && degraded.period.paydaySchedule.status === 'unavailable', 'the payday schedule is withheld');
  const today = degraded.period.fromTodayFunding;
  check(today.availableNow === 220 && today.contribution === null && today.cashAfterProposal === null
    && (today.items || []).every(item => item.contribution === null), 'today keeps available now; its proposals are withheld');
}

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
  // #1573 (lead, 2026-11-23): this world gives no card ledger evidence, so each card's charges already counted above
  // are unread and its target is a fall-back: the remainder is an estimate. Toward caution only. 'card-coverage' means a
  // card payment to confirm, and there is none here, so no cause is published (lead, 2026-11-23).
  check(noted.coverage.toConfirm === undefined && noted.coverage.trust === undefined
    && noted.period.fromTodayFunding.trust === 'estimated' && noted.period.fromTodayFunding.estimateCause === undefined,
    'a note names the card: no To-confirm row, coverage calculated; available now estimated by the card targets, with no card-payment cause');
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
  // A graded tag that exists only under the estimate is a newly published
  // figure too (pre-review note on 4a65663d): it may read estimated at most.
  // Tags the resolved run also carries graded are figures the withheld twin
  // simply omits, not coverage-dependent ones (the resolved run is their bound).
  const resolved = run(world([purchase, cashLeg(105, { notes: TRAVEL })]));
  const tr = tags(resolved.advice);
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
}

console.log('7. The Budget payment section shows the To-confirm row');
{
  const Detail = require('../public/bill-detail');
  const html = Detail.visaPaymentsHtml(degraded.period.visaPaymentBackfill, degraded.period.cardPurchaseCoverage);
  const rows = html.match(/data-card-payment-to-confirm-row/g) || [];
  check(rows.length === 1, 'one To-confirm row on the page');
  check(html.includes('To confirm: which card did this pay?') && html.includes('2026-09-20') && html.includes('$105.00')
    && html.includes('from Bills'), 'it shows the question, date, amount and the account it left');
  check(/counts toward no card/.test(html) && /estimates/.test(html), 'it says the payment counts toward no card and the figures are estimates');
  check(/data-card-payment-to-confirm data-trust="estimated"/.test(html), 'the block is tagged as an estimate');
  // Every printed string is escaped: a planted markup string never reaches the page raw.
  const planted = { ...degraded.period.cardPurchaseCoverage, toConfirm: [{ question: '<img src=x onerror=alert(1)>',
    date: '2026-09-20', amount: 105, fromAccount: '<b>x</b>' }] };
  const escaped = Detail.visaPaymentsHtml([], planted);
  check(!escaped.includes('<img') && !escaped.includes('<b>') && escaped.includes('&lt;img'), 'every printed string is escaped');
  const two = run(world([purchase, cashLeg(60), cashLeg(45)]));
  check((Detail.visaPaymentsHtml(two.period.visaPaymentBackfill, two.period.cardPurchaseCoverage)
    .match(/data-card-payment-to-confirm-row/g) || []).length === 2, 'two unconfirmed payments: two rows');
  const savings = run(world([purchase, cashLeg(105, {}, 'savings')], { reserveSavings: true, savingsOpening: 300 }));
  check(Detail.visaPaymentsHtml(savings.period.visaPaymentBackfill, savings.coverage).includes('from Savings'),
    'a Savings debit reads from Savings');
  const noted = run(world([purchase, cashLeg(105, { notes: TRAVEL })]));
  check(!/data-card-payment-to-confirm/.test(Detail.visaPaymentsHtml(noted.period.visaPaymentBackfill, noted.period.cardPurchaseCoverage)),
    'once confirmed, no To-confirm row');
}

console.log('8. The assistant packet: forward walks withheld, the rest estimated (lead B2 on #1358)');
{
  const Live = require('../scripts/live-plan');
  const Assistant = require('../scripts/assistant-packet');
  const packetOf = rows => Assistant.buildPacket({ data: Live.fromObservation(world(rows)).data, periods: null, questionsMarkdown: '' });
  const p = packetOf([purchase, cashLeg(105)]);
  const est = o => o && o.cardCoverageEstimate && o.cardCoverageEstimate.basis === 'card-payment-destination-unconfirmed'
    && o.cardCoverageEstimate.toConfirmCount === 1;
  check(p.planning.trajectory.status === 'unavailable' && est(p.planning.trajectory),
    'the monthly trajectory (walked at the cap) is withheld, with the estimate disclosure');
  check(p.forecast.horizon.minBalance === null && p.forecast.horizon.minDate === null, 'the projected low point is withheld');
  check(p.forecast.facilityCrossings.status === 'unavailable' && est(p.forecast.facilityCrossings), 'facility crossings are withheld');
  check(p.forecast.trust === 'estimated' && est(p.forecast), 'the forecast block is estimated, basis and To-confirm count named');
  check(p.forecast.currentPeriodAction.trust === 'estimated' && p.forecast.currentPeriodAction.weeklyCap === 165,
    'currentPeriodAction.weeklyCap (165, below the true 230) is tagged estimated');
  check(p.current.spendableHouseholdCash.trust === 'unknown' && est(p.current.spendableHouseholdCash),
    'a section already tagged unknown stays unknown (never more certain), with the disclosure');
  check(!JSON.stringify(p).includes('AB123') && !/coverageRef/.test(JSON.stringify(p.forecast)), 'no provider reference reaches the packet');
  // Packet tag audit against the withheld twin; packet numbers against the truth.
  const flat = (o, pre = '', m = {}) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
    if (v === null || typeof v !== 'object') m[pre + k] = v; else flat(v, pre + k + '.', m); } return m; };
  const fd = flat(p), fw = flat(packetOf([purchase, ['bills', -105, null, 'cash']]));
  const ft = flat(packetOf([purchase, cashLeg(105, { notes: TRAVEL })]));
  let graded = 0;
  for (const [k, v] of Object.entries(fd)) {
    if (!/(trust|Trust)$/.test(k) || !(v in RANK)) continue;
    if (fw[k] in RANK) check(RANK[v] <= RANK[fw[k]], `packet ${k}: ${v} no more certain than today's ${fw[k]}`);
    else { graded++; check(v === 'estimated', `packet ${k}: today ${fw[k]}, now ${v} (estimated at most)`); }
  }
  check(graded >= 3, `the packet audit reached the newly published sections (${graded})`);
  for (const [k, v] of Object.entries(fd)) {
    if (typeof v !== 'number' || typeof ft[k] !== 'number' || /At$|asOf|Count$|days|Days/i.test(k)) continue;
    // What a bill row still owes may only be overstated (H2-9: a covered minimum owes 0 in the truth).
    if (/^forecast\.currentPeriodAction\.bills\.\d+\.remaining$/.test(k)) { check(v >= ft[k] - 0.005, `packet ${k}: ${v} >= truth ${ft[k]}`); continue; }
    check(v <= ft[k] + 0.005, `packet ${k}: ${v} <= truth ${ft[k]}`);
  }
}

console.log('9. Every published figure, never above the truth, whichever card it paid');
{
  const Live = require('../scripts/live-plan');
  const Snapshot = require('../scripts/figures-snapshot');
  const snapOf = (rows, opts) => { const o = Live.fromObservation(world(rows, opts)); return Snapshot.buildFiguresSnapshot(o.data, o.data.periods || null); };
  // Higher is the cautious direction for these: what is still owed or reserved.
  // Debt owed is cautious when higher too. (Where the truth world adds the
  // second card's own payment credit, that card's provider balance itself
  // differs: an input difference, not card coverage.)
  const CAUTIOUS = [/^totals\.obligations$/, /^payday\.obligations$/, /^period\.[^.]+\.remainingBills$/, /reserve/i, /[Rr]equired/, /[Ss]hortfall/,
    /[Cc]onsumerDebt/, /^balance\.debts$/, /^revolving\.[^.]+\.(posted|used)$/,
    // The Stack credit lines' balance snapshot is the same card stock as
    // revolving.<id>.posted (the debt's balance, #1447), and its total is a sum of it.
    /^period\.[^.]+\.stackLine\.[^.]+\.balance$/, /^period\.[^.]+\.stackCardTotals\.balance$/];
  // advice.sim's raw walk: the Plan tab draws it directly and main publishes it
  // on every card hold too (from a zero-spend walk, higher still). Lead's call
  // on #1358 (option 1): named here, BACKLOG for the page's withheld path.
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
  compare([purchase, cashLeg(105)], [purchase, cashLeg(105, { notes: TRAVEL })], {}, 'vs Travel Visa');
  compare([purchase, cashLeg(105)], [purchase, cashLeg(105), cardCredit('card2', 105)], { twoCards: true }, 'vs another card');
  const both = [purchase, ['card2', 40, null, 'purchase']];
  compare([...both, cashLeg(105)], [...both, cashLeg(105, { notes: TRAVEL })], { twoCards: true }, 'both cards vs Travel Visa');
  compare([...both, cashLeg(105)], [...both, cashLeg(105), cardCredit('card2', 105)], { twoCards: true }, 'both cards vs the second card');
}

console.log('10. The operating answer names the estimate on its spending permission');
{
  const Live = require('../scripts/live-plan');
  const OA = require('../scripts/operating-answer');
  const answer = OA.fromRefreshedState(Live.fromObservation(world([purchase, cashLeg(105)])).data, { mode: 'live-overlay' });
  const permission = answer.currentSpendingPermission;
  check(permission && permission.trust === 'estimated' && permission.estimateBasis === 'card-payment-destination-unconfirmed'
    && permission.toConfirmCount === 1, 'currentSpendingPermission is tagged estimated with its basis and count');
  const resolved = OA.fromRefreshedState(Live.fromObservation(world([purchase, cashLeg(105, { notes: TRAVEL })])).data, { mode: 'live-overlay' });
  check(resolved.currentSpendingPermission.trust === undefined, 'confirmed: no estimate tag, as today');
}

console.log(`\nAll card-payment destination estimate checks passed (${checks}).`);
