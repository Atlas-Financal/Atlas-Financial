'use strict';
/* BACKLOG obs 4 (a) and (b) (#1298 review; lead ruling, ATLAS LEAD 11, 2026-11-19): the "card payment: <card>" note is
 * the bank-side identity (operating contract). Neither conflict resolves silently, and both resolve the cautious way.
 *   (a) A payment-like card credit never pairs with a debit whose note names a different card. The near debit is
 *       contradicting evidence, so the credit withholds, as any other contradicting near leg already does.
 *   (b) A debit whose payee identity names one manual card (payDown) while its note names another pays no card. It
 *       is held To confirm once by the held reader, with reason 'card-payment-destination-conflict'; its minimum stays
 *       to confirm; and the card drawer names the conflict where the held list does not list it (Savings).
 *
 * Path: invented raw Lunch Money rows (notes included) -> scripts/live-plan.js fromObservation -> the served packet
 * (the note's card stamped as cardPaymentNoteDestination, the raw note dropped) -> Forecast.recommend (card coverage,
 * the active period's held list and drawer, From-today funding, Balance After Deductions).
 *
 * Invented world (test/fixtures/card-coverage-aggregate-world.js): payday anchor 2026-09-18, as of 2026-09-20, Bills
 * 500, groceries 150, a 25 card minimum due on the as-of. By hand:
 *   (a) an 80 grocery purchase on the travel card; a 105 TD "TFR-TO C/C" Bills debit and an equal -105 payment-like
 *       credit on the travel card.
 *       - Paired (no note, or a note naming the travel card): the 105 covers the 25 minimum and the 80 purchase;
 *         available now = (500 - 105) - (150 - 80) = 325.
 *       - Noted for the cash back card: they pair with neither. The credit has a contradicting near leg, so coverage
 *         withholds (available now unavailable, never above 325).
 *   (b) payDownOnly [mbna], an MBNA 25 minimum; a 60 Bills debit with the MBNA payee identity.
 *       - No note, or a note naming MBNA: pays the minimum 25 and 35 beyond; available = (500 - 60) - 150 = 290;
 *         Balance After Deductions = 1000 - 25 - 150 - 35 = 790.
 *       - Noted for Triangle: pays no card. It is held once, the minimum stays to confirm; available
 *         = (500 - 60) - 25 - 150 = 265; Balance After Deductions = 1000 - 25 - 150 - 60 held = 765. These are the
 *         figures of a no-identity payment (#1388 / #1401), and the cautious side of 290 / 790.
 *       - From Savings, noted for Triangle: Bills untouched, the minimum stays held; available = 500 - 25 - 150 = 325
 *         (it was 350 with the minimum paid). Not held (Savings), so the drawer asks, naming the conflict.
 *   (c) Every other path a conflicted debit can reach pays no card either (Codex P1 on #1407): a Lunch Money group
 *       (U5) and the TD note path. Hand values are in section (c).
 *
 * `node test/test-card-payment-note-conflicts.js`
 */
const assert = require('node:assert/strict');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

function serve(rows, opts) {
  const s = run(world(rows, opts));
  const period = s.advice.defaultView.calendarPeriods[0];
  const drawer = period.cardPurchaseCoverage || {};
  const held = period.heldOutflowsToConfirm;
  return { s, coverage: s.coverage, available: s.period.fromTodayFunding.availableNow,
    afterDeductions: s.advice.defaultView.predictedEndingBalance,
    reconciled: (s.coverage.payments || []).filter(p => p.status === 'reconciled').length,
    minimum: (s.coverage.minimumCoverage || []).map(m => [m.covered, m.status]),
    issues: (s.coverage.issues || []).map(i => i.code),
    asked: (drawer.toConfirm || []).map(r => [r.amount, r.diagnostic || null]), listed: drawer.toConfirmListedUnderHeld || 0,
    held: held && Array.isArray(held.recon) ? held.recon.map(r => [r.amount, r.reason || r.includeReason || null]) : [],
    debit: s.packet.transactions.find(t => t.amount === 105 || t.amount === 60) };
}

console.log('(a) a payment-like card credit and a debit noted for another card pair with neither');
{
  const td = notes => ['bills', 105, null, 'cash', { payee: 'TFR-TO C/C', original_name: 'AB123 TFR-TO C/C',
    category_name: 'Credit Card Payment', ...(notes ? { notes } : {}) }];
  const credit = ['card', -105, null, 'credit', { payee: 'Invented card payment', category_name: 'Credit Card Payment' }];
  const purchase = ['card', 80, null, 'purchase'];
  const control = serve([purchase, td(null), credit]);
  ok(control.reconciled === 1 && control.available === 325 && JSON.stringify(control.minimum) === '[[25,"covered-by-payment"]]',
    'control (no note): they pair; the minimum and the purchase are covered; available 325', JSON.stringify([control.reconciled, control.available]));
  const same = serve([purchase, td('card payment: Travel Visa'), credit]);
  ok(same.reconciled === 1 && same.available === 325, 'a note naming the credit\'s own card still pairs; available 325');
  const other = serve([purchase, td('card payment: TD Cash Back Visa'), credit]);
  ok(other.debit.cardPaymentNoteDestination === 'cashback' && !Object.hasOwn(other.debit, 'notes'),
    'the packet carries only the note\'s card (cash back), never the note text');
  ok(other.reconciled === 0 && other.coverage.status === 'unavailable' && other.issues.includes('coverage-payment-source-unconfirmed'),
    'noted for the cash back card: no pair; the credit\'s contradicting near leg withholds coverage', JSON.stringify(other.issues));
  ok(other.available === null && JSON.stringify(other.minimum) === '[[0,"to-confirm"]]',
    'available now is withheld (never above 325) and the minimum is not paid by it');
}

console.log('(b) a payee destination its note contradicts pays no card and is held To confirm once');
{
  const policy = { rule: 'aggregate-per-card-per-pay-period', payDownOnly: ['mbna'],
    opening: { asOf: '2026-09-18', confirmed: true, currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] } };
  const opts = { card: 'mbna', policy };
  const mbna = (account, notes) => [account, 60, null, 'cash', { payee: 'MBNA PAYMENT', category_name: 'Credit Card Payment',
    ...(notes ? { notes } : {}) }];
  for (const [why, notes] of [['no note', null], ['a note naming MBNA', 'card payment: MBNA']]) {
    const x = serve([mbna('bills', notes)], opts);
    ok(JSON.stringify(x.minimum) === '[[25,"covered-by-payment"]]' && x.available === 290 && x.afterDeductions === 790
      && x.held.length === 0 && x.asked.length === 0, why + ': pays the MBNA minimum and 35 beyond; 290 / 790; nothing To confirm',
    JSON.stringify([x.minimum, x.available, x.afterDeductions, x.held, x.asked]));
  }
  const conflict = serve([mbna('bills', 'card payment: Triangle Mastercard')], opts);
  ok(conflict.debit.cardPaymentDestination === 'mbna' && conflict.debit.cardPaymentNoteDestination === 'triangle',
    'the packet carries both cards: the payee\'s (MBNA) and the note\'s (Triangle)');
  ok(conflict.reconciled === 0 && JSON.stringify(conflict.minimum) === '[[0,"to-confirm"]]',
    'neither wins: it pays no card and the MBNA minimum stays to confirm');
  ok(JSON.stringify(conflict.held) === '[[60,"card-payment-destination-conflict"]]' && conflict.asked.length === 0 && conflict.listed === 1,
    'held To confirm once, with the conflict named; the drawer points to it instead of asking again',
    JSON.stringify([conflict.held, conflict.asked, conflict.listed]));
  ok(conflict.available === 265 && conflict.afterDeductions === 765,
    'counted once as money out: available 265, Balance After Deductions 765 (the cautious side of 290 / 790)',
    JSON.stringify([conflict.available, conflict.afterDeductions]));
  const savings = serve([mbna('savings', 'card payment: Triangle Mastercard')], { ...opts, savingsOpening: 500 });
  ok(savings.held.length === 0 && JSON.stringify(savings.asked) === '[[60,"card-payment-destination-conflict"]]',
    'from Savings: not held, so the drawer asks and names the conflict', JSON.stringify([savings.held, savings.asked]));
  ok(savings.available === 325 && JSON.stringify(savings.minimum) === '[[0,"to-confirm"]]',
    'from Savings: the minimum stays held; available 325 (was 350 with the minimum paid)');
  const question = (savings.s.advice.defaultView.calendarPeriods[0].cardPurchaseCoverage.toConfirm || [])[0];
  ok(question && /payee and its note name different cards/.test(question.question), 'the question says why');
}

console.log('(c) every pairing path refuses a payee/note conflict (Codex P1 on #1407)');
{
  // Invented: two cards (travel and an MBNA payDown card), the travel card's 25 minimum, an 80 travel purchase, and
  // a 105 Bills debit. By hand: Bills (500 - 105) = 395; groceries left 150 - 80 = 70.
  //   - paid: available = 395 - 70 = 325; Balance After Deductions = 1000 - 25 - 150 = 825.
  //   - a conflict debit held To confirm: Balance After Deductions = 1000 - 25 - 150 - 105 held = 720.
  const opts = { twoCards: true, payDownOnly: ['mbna'] };
  const group = { group_parent_id: 777001 };
  const purchase = ['card', 80, null, 'purchase'];
  const credit = ['card', -105, null, 'credit', { payee: 'Invented card payment', category_name: 'Credit Card Payment', ...group }];
  const debit = (payee, extra) => ['bills', 105, null, 'cash', { payee, category_name: 'Credit Card Payment',
    notes: 'card payment: Travel Visa', ...extra }];
  const read = x => ({ status: x.coverage.status, paid: x.reconciled, available: x.available, afterDeductions: x.afterDeductions,
    held: x.held, minimum: x.minimum });
  // U5 group: Codex's world. A grouped MBNA-payee debit noted for the travel card beside a grouped travel credit.
  const grouped = read(serve([purchase, debit('MBNA PAYMENT', group), credit], opts));
  ok(grouped.status === 'unavailable' && grouped.paid === 0 && grouped.available === null,
    'group: the conflict pays no card; the group withholds, so 325 is never published', JSON.stringify(grouped));
  ok(JSON.stringify(grouped.held) === '[[105,"card-payment-destination-conflict"]]' && grouped.afterDeductions === 720
    && JSON.stringify(grouped.minimum) === '[[0,"to-confirm"]]',
  'group: held To confirm once and counted once as money out (Balance After Deductions 720); minimum to confirm');
  const groupedControl = read(serve([purchase, debit('Invented card payment', group), credit], opts));
  ok(groupedControl.paid === 1 && groupedControl.available === 325 && groupedControl.afterDeductions === 825
    && groupedControl.held.length === 0, 'group control (no payee identity): the group pays the travel card; 325 / 825');
  // TD note path: an MBNA-payee TD "TFR-TO C/C" debit noted for the travel card, no credit.
  const td = read(serve([purchase, debit('MBNA PAYMENT', { original_name: 'AB123 TFR-TO C/C' })], opts));
  ok(td.paid === 0 && JSON.stringify(td.held) === '[[105,"card-payment-destination-conflict"]]'
    && td.available === 220 && td.afterDeductions === 720,
  'TD note path: the note does not pay the travel card; held once; available 395 - 25 - 70 - 80 = 220; 720', JSON.stringify(td));
  const tdControl = read(serve([purchase, debit('TFR-TO C/C', { original_name: 'AB123 TFR-TO C/C' })], opts));
  ok(tdControl.paid === 1 && tdControl.available === 325 && tdControl.afterDeductions === 825 && tdControl.held.length === 0,
    'TD note control (no payee identity): the note pays the travel card; 325 / 825');
}

console.log(`\nAll card payment note conflict checks passed (${checks}).`);
