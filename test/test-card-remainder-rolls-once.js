'use strict';
/* An unpaid card remainder rolls over to the next pay period, once (Dale, lead 13 item B; LEAD 14 #1620 7182740397 part
 * 3, mechanics 7194071146). The card ledger is the one authority: when the current pay period opens, a minimum of the
 * period just closed that its own payments met only in part (a known remainder) becomes one carried line in the current
 * period, "carried from" its original date, paid first by this period's payments. The walk and the Bills rows read
 * that same line.
 *   1. Partly paid (20 of 25): 5.00 is carried; the Bills row says "carried from", 5.00 still due, estimated; the cash
 *      walk deducts it once.
 *   2. Paid this period: like any card minimum, the row keeps the 5.00 planned and shows what was paid as actual (a
 *      5.00 payment marks it paid, a 2.00 payment leaves 3.00), so paying it never puts the cash back into the period's
 *      bill load, Balance After Deductions or the next opening (T3 review of record on #1663, finding 1). Either way
 *      cash counts the carry once.
 *   3. No carry: paid in full, or not paid at all (the remainder is not known).
 *   4. Once: two pay periods later nothing is carried.
 *   5. No carry onto a recorded statement this period (it already includes the past-due amount).
 *   6. Mutants: the carry removed; the carry ignoring this period's payments (a double count); and one per repair.
 *   7. The Stack bills split counts the carry as its card's minimum, so Credit nets it once (finding 2).
 *   8. An unrelated unknown-amount bill does not drop the carry from the debt or cash walk (finding 3).
 *   9. Only a payment the household noted to the card ("card payment: <card>", not "(by amount)") makes or pays down
 *      a carry (Grok Bot, rule 17): an unnamed transfer-to-card, often purchase backfill, does neither.
 * Invented world (test/fixtures/card-coverage-aggregate-world.js): pay periods 09-18..10-01, 10-02..10-15,
 * 10-16..10-29; Bills 500; one 25 card minimum due 2026-09-25. Every expectation is written by hand.
 * `node test/test-card-remainder-rolls-once.js` */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const F = require('../public/forecast');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => { checks++; if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ' — ' + detail : ''}`); };
const J = JSON.stringify;
const cents = x => Math.round(Number(x) * 100);
// A card payment the household noted to the Travel card (Grok Bot, rule 17: "partly paid" rests on confirmed
// card-payment notes only), and the same transfer with no note: a generic "TFR-TO C/C" that names no card.
const pay = (amount, date, notes = 'card payment: Travel Visa') => [['bills', amount, date, 'cash', { notes }], ['card', -amount, date, 'credit']];
const payUnnamed = (amount, date) => [['bills', amount, date, 'cash'], ['card', -amount, date, 'credit']];
const OPTS = { asOf: '2026-10-05', minimumDate: '2026-09-25' };
const carriedLines = s => (s.coverage.minimumCoverage || []).filter(r => r.carriedFrom);
const carriedRows = s => (s.period.bills || []).filter(b => b.carriedRemainder);
// The cash walk's card-minimum outflow (the weekly allowance is solved around it, so the ending balance is not the test).
const walked = s => cents(s.advice.sim.totals.obligations);

function withEngine(engine, fn) {
  const real = { ...F };
  Object.assign(F, engine);
  try { return fn(); } finally { Object.assign(F, real); }
}

console.log('1. Partly paid (20 of 25): 5.00 rolls into the current pay period');
const partial = run(world(pay(20, '2026-09-26'), OPTS));
{
  const lines = carriedLines(partial);
  ok(lines.length === 1 && cents(lines[0].due) === 500 && cents(lines[0].covered) === 0 && lines[0].carriedFrom === '2026-09-25'
    && lines[0].carriedInto === '2026-10-02', 'the card ledger carries one 5.00 line from 2026-09-25 into the 10-02 period', J(lines));
  const original = (partial.coverage.minimumCoverage || []).filter(r => !r.carriedFrom);
  ok(original.length === 1 && cents(original[0].covered) === 2000 && original[0].status === 'partial',
    'the closed period keeps its own record (20 of 25, partial): history is unchanged', J(original));
  const rows = carriedRows(partial);
  ok(rows.length === 1 && cents(rows[0].remaining) === 500 && rows[0].status === 'still due' && /carried from 2026-09-25/.test(rows[0].label)
    && rows[0].confidence === 'estimated', 'the Bills row: "carried from 2026-09-25", 5.00 still due, estimated',
    J(rows.map(r => [r.label, r.remaining, r.status, r.confidence])));
  ok(walked(partial) === 500, 'the cash walk takes the 5.00 out once (it was dropped at payday before)', J(walked(partial)));
}

console.log('2. Paid this period: the carry is paid first, and cash counts it once');
{
  const cleared = run(world([...pay(20, '2026-09-26'), ...pay(5, '2026-10-03')], OPTS));
  const line = carriedLines(cleared)[0];
  const paidRow = carriedRows(cleared);
  ok(line && line.status === 'covered-by-payment' && paidRow.length === 1 && cents(paidRow[0].planned) === 500
    && cents(paidRow[0].actual) === 500 && cents(paidRow[0].remaining) === 0 && paidRow[0].status === 'PAID',
    'a 5.00 payment on 10-03 covers the carried line: the row stays, 5.00 planned, 5.00 paid, nothing left, PAID',
    J(paidRow.map(r => [r.planned, r.actual, r.remaining, r.status])));
  const part = run(world([...pay(20, '2026-09-26'), ...pay(2, '2026-10-03')], OPTS));
  const rows = carriedRows(part);
  ok(rows.length === 1 && cents(rows[0].planned) === 500 && cents(rows[0].actual) === 200 && cents(rows[0].remaining) === 300,
    'a 2.00 payment: 5.00 planned, 2.00 paid, 3.00 still due', J(rows.map(r => [r.planned, r.actual, r.remaining])));
  // Paying a bill during the period never puts its cash back (ARCHITECTURE.md, Balance After Deductions): the
  // period's bill load stays the 5.00 carry, and Balance After Deductions (1,000 income − 5.00 − 150 hold = 845.00)
  // and the next period's opening are the same unpaid, part paid and paid.
  const shape = s => [cents(s.period.periodBillLoad), cents(s.period.balanceAfterDeductions),
    cents((s.advice.payPeriodViews.find(v => v.start === '2026-10-16') || {}).opening)];
  ok([partial, part, cleared].every(s => J(shape(s)) === J([500, 84500, shape(partial)[2]])),
    'paying the carry moves no cash back: bill load 5.00 and Balance After Deductions 845.00 unpaid, part paid and paid; the next opening unchanged',
    J([partial, part, cleared].map(shape)));
  // What was paid this period plus what the walk still takes out is the 5.00 carry, once: 5 + 0, 2 + 3, 0 + 5.
  ok(walked(cleared) === 0 && walked(part) === 300,
    'the walk takes out 0.00 after the 5.00 payment and 3.00 after the 2.00 one: the carry leaves cash exactly once',
    J([walked(cleared), walked(part)]));
}

console.log('3. No carry when there is no known remainder');
{
  const paid = run(world(pay(25, '2026-09-26'), OPTS));
  ok(carriedLines(paid).length === 0 && carriedRows(paid).length === 0, 'paid in full: nothing rolls');
  const none = run(world([], OPTS));
  ok(carriedLines(none).length === 0 && carriedRows(none).length === 0, 'not paid at all (remainder unknown): nothing rolls');
}

console.log('4. Once: two pay periods later nothing is carried');
{
  const later = run(world(pay(20, '2026-09-26'), { ...OPTS, asOf: '2026-10-20' }));
  ok(carriedLines(later).length === 0 && carriedRows(later).length === 0, 'as of 10-20 the 09-25 remainder does not roll again',
    J(carriedLines(later)));
}

console.log('5. No carry onto a recorded statement this period');
{
  const statement = run(world(pay(20, '2026-09-26'), { ...OPTS, edit: x => {
    const base = x.data.plan.obligations[0];
    x.data.plan.obligations.push({ ...base, id: 'travel-oct', date: '2026-10-10',
      statementOccurrences: [{ scheduledDate: '2026-10-10', dueDate: '2026-10-10', minimum: 30, currency: 'cad', confidence: 'confirmed' }] });
  } }));
  ok(carriedLines(statement).length === 0 && carriedRows(statement).length === 0,
    'the card\'s 10-10 statement (it already includes the past-due amount) takes no carry', J(carriedLines(statement)));
}

console.log('5b. The coupled debt and cash walks (Codex on #1663)');
{
  // The same obligation also due on the as-of (biweekly from 09-25: 09-25, then 10-09): its own 25 and the 5.00 carry
  // are two occurrences, so the debt walk keys them apart and the cash walk takes out 25 + 5 = 30.00.
  const biweekly = x => { const o = x.data.plan.obligations[0]; delete o.date; o.frequency = 'biweekly'; o.anchor = '2026-09-25'; };
  const sameDay = run(world(pay(20, '2026-09-26'), { ...OPTS, asOf: '2026-10-09', edit: biweekly }));
  const fullyPaid = run(world(pay(25, '2026-09-26'), { ...OPTS, asOf: '2026-10-09', edit: biweekly }));
  // The walk's own minimums (10-09 and 10-23, 25.00 each) are the same in both worlds; the carry adds exactly 5.00.
  ok(carriedRows(sameDay).length === 1 && walked(fullyPaid) === 5000 && walked(sameDay) === 5500,
    'a minimum due the same day keeps its own 25.00 beside the 5.00 carry: 50.00 + 5.00 against 50.00 fully paid',
    J([carriedRows(sameDay).length, walked(sameDay), walked(fullyPaid)]));
  // The card is observed nearly paid off (3.00 owing): a payment cannot exceed the debt it pays, so cash takes out
  // 3.00 of the carry, the same cap every other obligation gets from the debt walk.
  const owing3 = run(world(pay(20, '2026-09-26'), { ...OPTS, edit: x => { x.payload.accounts[3].balance = 3; } }));
  ok(walked(owing3) === 300, 'with 3.00 owing on the card, cash takes out 3.00 of the carry, not 5.00', J(walked(owing3)));
  const paidOff = run(world(pay(20, '2026-09-26'), { ...OPTS, edit: x => { x.payload.accounts[3].balance = 0; } }));
  ok(walked(paidOff) === 0, 'with the card paid off, the carry takes nothing out of cash', J(walked(paidOff)));
}

console.log('5c. A pay-down-only card: a payment beyond the carry still meets the next minimum early');
// Invented pay-down-only card (one-sided Bills debits with the card's payment identity, as in
// test-card-coverage-aggregate-rule section 14): 25 due 09-25 with 10 paid 09-26 leaves a 15.00 carry; the next
// minimum, 25 due 10-25, is in the period after; 60 paid 10-03. Beyond the minimum: 60 - 15 carried - 25 met early = 20.
const payDown = (amount, date) => ['bills', amount, date, 'cash', { payee: 'MBNA M/C', category_name: 'DEBT&PAYMENTS', notes: 'card payment: MBNA' }];
const PAYDOWN = { card: 'mbna', payDownOnly: ['mbna', 'triangle'], asOf: '2026-10-05', minimumDate: '2026-09-25',
  edit: x => { const b = x.data.plan.obligations[0]; x.data.plan.obligations.push({ ...b, id: 'mbna-next', date: '2026-10-25' }); } };
const beyondCents = s => (s.coverage.payDownBeyondMinimum || []).reduce((sum, r) => sum + cents(r.amount), 0);
const payDownCarry = () => run(world([payDown(10, '2026-09-26'), payDown(60, '2026-10-03')], PAYDOWN));
{
  const s = payDownCarry();
  const carried = carriedLines(s);
  ok(carried.length === 1 && cents(carried[0].due) === 1500 && cents(carried[0].covered) === 1500,
    'the 15.00 carry is paid first by the 10-03 payment', J(carried));
  ok(beyondCents(s) === 2000, '60.00 - 15.00 carried - 25.00 met early = 20.00 beyond the minimum', J(beyondCents(s)));
  const next = s.advice.payPeriodViews.find(v => v.start === '2026-10-16');
  const nextRow = next && (next.bills || []).find(b => b.id === 'mbna-next');
  ok(nextRow && cents(nextRow.remaining) === 2500, 'the next period keeps its own 25.00 (the early-met part is not counted twice)',
    J(nextRow && nextRow.remaining));
}

console.log('7. The Stack bills split: the carry is its card\'s minimum (T3 review of record on #1663, finding 2)');
{
  const row = carriedRows(partial)[0];
  const split = partial.period.stackSummary && partial.period.stackSummary.bills;
  ok(row && row.stackBillPart === 'cardMinimum' && row.stackBillDebtId === 'travelvisa'
    && J(split && split.cardMinimums) === J([{ debtId: 'travelvisa', amount: 5 }]) && split.other === 0,
    'the carried row is the Travel card\'s minimum (5.00), not "other"', J([row && row.stackBillPart, split]));
}
{
  // Credit (Desk ruling E): a 50.00 card purchase this period, synced card: target max(5.00 carried
  // minimum, 50.00) = 50.00, all of it already in the groceries hold, so the deduction is 0 and the adjustment takes the
  // 5.00 minimum back once: 1,000 − 5.00 − 150 + 5.00 = 850.00. Counted as "other", the 5.00 was deducted beside the
  // purchase it repays (845.00).
  const Live = require('../scripts/live-plan');
  const x = world([...pay(20, '2026-09-26'), ['card', 50, '2026-10-03', 'purchase']], { ...OPTS, edit: w => {
    w.payload.accounts[3].last_fetch = w.asOf + 'T17:00:00Z'; w.payload.accounts[3].plaid_last_successful_update = w.asOf + 'T17:00:00Z'; } });
  const o = Live.fromObservation(x), ov = o.data.liveOverlay;
  const r = F.recommend(o.data.plan, x.asOf, { debts: o.data.debts, currentPeriodActuals: ov.currentPeriodActuals,
    cardPeriodBalanceEvidence: ov.cardPeriodBalanceEvidence, cardLiveOverlay: { applied: true, overlays: ov.overlays } });
  const v = r.payPeriodViews.find(p => p.start === '2026-10-02');
  ok(v && cents(v.balanceAfterDeductions) === 85000 && cents(v.predictedEndingBalanceTerms.cardRepaymentAdjustment) === -500,
    'Credit nets the carried minimum once beside the purchase it repays: 850.00, adjustment −5.00',
    J(v && [v.balanceAfterDeductions, v.predictedEndingBalanceTerms.cardRepaymentAdjustment]));
}

console.log('8. An unrelated unknown amount does not drop the carry (T3 review of record on #1663, finding 3)');
// An invented monthly bill with a malformed amount (unknown) turns on the debt walk's omission trace.
const unknownGym = w => { const o = w.data.plan.obligations[0];
  w.data.plan.obligations.push({ id: 'gym', label: 'Invented gym', effect: 'payment', frequency: 'monthly', day: 10, amount: '1,900',
    confidence: 'estimated', payingAccount: o.payingAccount }); };
function absorbedWithUnknown() {
  const s = run(world(pay(20, '2026-09-26'), { ...OPTS, edit: unknownGym }));
  return F.projectDebts(s.observed.data.plan, s.observed.data.debts, OPTS.asOf, { currentPeriodActuals: s.packet }).obligationAbsorbed || {};
}
{
  const absorbed = absorbedWithUnknown();
  ok(absorbed['2026-10-05:travel#carried@2026-09-25'] === 5, 'the debt walk still pays the 5.00 carry down on the card', J(absorbed));
  const s = run(world(pay(20, '2026-09-26'), { ...OPTS, edit: unknownGym }));
  const ev = (s.advice.sim.events || []).filter(e => e.carriedRemainder).map(e => [e.date, cents(-e.amount)]);
  ok(J(ev) === J([['2026-10-05', 500]]), 'the cash walk still takes the 5.00 carry out on the as-of', J(ev));
}

console.log('9. Only a payment noted to the card makes or pays a carry (Grok Bot, rule 17, #1620 7201859819)');
{
  // The 09-25 minimum met 20.00 by a transfer that names no card (often purchase backfill): its 5.00 remainder is not
  // known to be a partly paid minimum, so nothing rolls (as on main).
  const unnamed = run(world(payUnnamed(20, '2026-09-26'), OPTS));
  ok(carriedLines(unnamed).length === 0 && carriedRows(unnamed).length === 0 && walked(unnamed) === 0,
    'an unnamed 20.00 transfer-to-card makes no carry', J(carriedLines(unnamed)));
  // A note that named the card only by amount is not a confirmed card-payment note.
  const byAmount = run(world(pay(20, '2026-09-26', 'card payment: Travel Visa (by amount)'), OPTS));
  ok(carriedLines(byAmount).length === 0, 'a "(by amount)" note makes no carry', J(carriedLines(byAmount)));
  // One noted and one unnamed payment together: the remainder rests partly on the unnamed one, so nothing rolls.
  const mixed = run(world([...pay(10, '2026-09-26'), ...payUnnamed(10, '2026-09-27')], OPTS));
  ok(carriedLines(mixed).length === 0, 'a remainder that rests partly on an unnamed transfer makes no carry', J(carriedLines(mixed)));
  // A noted carry is not paid down by an unnamed 2.00 transfer this period: the line still owes 5.00.
  const shrink = run(world([...pay(20, '2026-09-26'), ...payUnnamed(2, '2026-10-03')], OPTS));
  const line = carriedLines(shrink)[0], row = carriedRows(shrink)[0];
  ok(line && cents(line.covered) === 0 && row && cents(row.remaining) === 500 && walked(shrink) === 500,
    'an unnamed 2.00 transfer this period does not shrink the 5.00 carry', J([line, row && row.remaining, walked(shrink)]));
}

console.log('6. Mutants');
{
  const FILE = path.join(__dirname, '..', 'public', 'forecast.js');
  const source = fs.readFileSync(FILE, 'utf8');
  const compile = (from, to, tag) => {
    if (source.split(from).length !== 2) throw new Error('mutant anchor not found exactly once: ' + tag);
    const mod = new Module(FILE, module);
    mod.filename = FILE;
    mod.paths = Module._nodeModulePaths(path.dirname(FILE));
    mod._compile(source.replace(from, to), FILE.replace(/\.js$/, '-' + tag + '.js'));
    return mod.exports;
  };
  const noCarry = compile("if (start === currentPeriodStart && previousPeriodStart && !(period.minimums || []).some(m => m.statement)) {",
    'if (false) {', 'no-carry');
  const m1 = withEngine(noCarry, () => run(world(pay(20, '2026-09-26'), OPTS)));
  ok(carriedRows(m1).length === 0 && walked(m1) === 0,
    'MUTANT (no carry): the 5.00 drops out of the walk and the Bills rows, which section 1 rejects', J([carriedRows(m1).length, walked(m1)]));
  const ignorePaid = compile('const carried = event.carriedRemainder;', 'const carried = null;', 'ignore-paid');
  const m2 = withEngine(ignorePaid, () => run(world([...pay(20, '2026-09-26'), ...pay(2, '2026-10-03')], OPTS)));
  ok(walked(m2) === 500, 'MUTANT (carry ignores this period\'s payments): the walk still takes 5.00 after 2.00 was paid (7.00 counted), which section 2 rejects',
    J(walked(m2)));
}

{
  const FILE = path.join(__dirname, '..', 'public', 'forecast.js');
  const source = fs.readFileSync(FILE, 'utf8');
  const compile = (from, to, tag) => {
    if (source.split(from).length !== 2) throw new Error('mutant anchor not found exactly once: ' + tag);
    const mod = new Module(FILE, module);
    mod.filename = FILE;
    mod.paths = Module._nodeModulePaths(path.dirname(FILE));
    mod._compile(source.replace(from, to), FILE.replace(/\.js$/, '-' + tag + '.js'));
    return mod.exports;
  };
  const biweekly = x => { const o = x.data.plan.obligations[0]; delete o.date; o.frequency = 'biweekly'; o.anchor = '2026-09-25'; };
  const sharedId = compile("const id = row.obligationId + '#carried@' + row.carriedFrom;", 'const id = row.obligationId;', 'shared-id');
  const m3 = withEngine(sharedId, () => run(world(pay(20, '2026-09-26'), { ...OPTS, asOf: '2026-10-09', edit: biweekly })));
  ok(walked(m3) !== 5500, 'MUTANT (carry shares the obligation\'s identity): the same-day walk no longer counts 25.00 + 5.00, which section 5b rejects',
    J(walked(m3)));
  const ownOnly = compile('!minimums.some(m => !m.carriedFrom)', '!minimums.length', 'carry-blocks-early-met');
  const m5 = withEngine(ownOnly, () => payDownCarry());
  ok(beyondCents(m5) === 4500, 'MUTANT (a carry switches early-met off): 45.00 beyond the minimum, 25.00 counted twice, which section 5c rejects',
    J(beyondCents(m5)));
  const noCap = compile('      if (cap) {\n        const key = date + \':\' + id;', '      if (false) {\n        const key = date + \':\' + id;', 'no-cap');
  const m4 = withEngine(noCap, () => run(world(pay(20, '2026-09-26'), { ...OPTS, edit: x => { x.payload.accounts[3].balance = 3; } })));
  ok(walked(m4) === 500, 'MUTANT (no debt cap on the carry): cash takes out 5.00 with only 3.00 owing, which section 5b rejects', J(walked(m4)));
  const shrinkOnPay = compile('      let amount = due / 100;\n', '      let amount = (due - covered) / 100;\n', 'shrink-on-pay');
  const m6 = withEngine(shrinkOnPay, () => run(world([...pay(20, '2026-09-26'), ...pay(5, '2026-10-03')], OPTS)));
  ok(carriedRows(m6).every(r => cents(r.planned) !== 500) && cents(m6.period.balanceAfterDeductions) !== 84500,
    'MUTANT (the row shrinks as it is paid): the paid carry leaves the bill load and its cash returns to Balance After Deductions, which section 2 rejects',
    J([carriedRows(m6).map(r => r.planned), m6.period.balanceAfterDeductions]));
  const ownId = compile('return row && row.carriedRemainder ? row.carriedRemainder.obligationId : row && row.id;', 'return row && row.id;', 'own-id');
  const m7 = withEngine(ownId, () => run(world(pay(20, '2026-09-26'), OPTS)));
  ok(carriedRows(m7).every(r => r.stackBillPart === 'other'),
    'MUTANT (rows mapped to a plan obligation by their own id): the carry is split as "other", not its card\'s minimum, which section 7 rejects',
    J(carriedRows(m7).map(r => r.stackBillPart)));
  const anyPayment = compile('|| !(m.payments || []).length || !m.payments.every(part => part.confirmedNote)) continue;', ') continue;', 'any-payment');
  const m9 = withEngine(anyPayment, () => run(world(payUnnamed(20, '2026-09-26'), OPTS)));
  ok(carriedLines(m9).length === 1,
    'MUTANT (any payment makes a carry): an unnamed transfer-to-card makes a 5.00 carry, which section 9 rejects', J(carriedLines(m9)));
  const anyPayer = compile('if (minimum.carriedFrom && !confirmedNote) continue;', '', 'any-payer');
  const m10 = withEngine(anyPayer, () => run(world([...pay(20, '2026-09-26'), ...payUnnamed(2, '2026-10-03')], OPTS)));
  ok(carriedRows(m10).some(r => cents(r.remaining) === 300),
    'MUTANT (any payment pays the carry): an unnamed 2.00 transfer shrinks it to 3.00, which section 9 rejects', J(carriedRows(m10).map(r => r.remaining)));
  const noTrace = compile('    if (omissionTrace && Array.isArray(omissionTrace.items)) {\n      const carriedLines', '    if (false) {\n      const carriedLines', 'no-trace');
  const m8 = withEngine(noTrace, () => absorbedWithUnknown());
  ok(!(m8['2026-10-05:travel#carried@2026-09-25'] > 0),
    'MUTANT (the carry left out of the omission trace): an unrelated unknown amount drops it from the debt walk, which section 8 rejects', J(m8));
}

console.log(`\n${failures ? 'FAIL' : 'PASS'} card remainder rolls once (${checks - failures}/${checks})`);
if (failures) process.exit(1);
