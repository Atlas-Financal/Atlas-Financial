'use strict';
/* A18 — a refunded category purchase never overstates the Bills close.
 *
 * Household Budget Spent nets an identified category refund (G3a), but
 * the Bills-account projection read its funding rows without
 * categoryRefunds, so a Bills purchase stayed "funded" after its refund
 * came back. Result: the close was overstated by the refund.
 *
 * Invariant proved here: the close depends only on NET category spend.
 * A purchase plus its refund closes exactly like no purchase; a 150
 * purchase with 50 refunded closes exactly like a plain 100 purchase.
 *
 * Invented requirements fixture (test/fixtures/bills-period-end-balance-data
 * requirementsFixture), expected values computed by hand below, through
 * the public Forecast.billsAccountPeriodBalance path.
 *
 * `node test/test-bills-close-refund-conservation.js`
 */
const F = require('../public/forecast');
const fx = require('./fixtures/bills-period-end-balance-data');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.005;

// Hand arithmetic from the fixture's invented cents:
//   Bills cash 823.47; future income 263.19; remaining bill 17.23;
//   commitment 9.41; targets groceries 71.13 + eating out 29.27 = 100.40.
const BILLS = 823.47, INCOME = 263.19, BILL = 17.23, COMMIT = 9.41;
const TARGET = 71.13 + 29.27;
const BASE_CLOSE = BILLS + INCOME - BILL - COMMIT - TARGET;          // 959.62
// Groceries net spend 100 > 71.13: hold 100 + 29.27, funded 100 from Bills,
// remaining 29.27, Bills cash down by 100.
const OVER_CLOSE = (BILLS - 100) + INCOME - BILL - COMMIT - 29.27;   // 930.75

function close(change) {
  const x = fx.requirementsFixture();
  if (change) change(x);
  x.opts.observedCash.accounts.find(r => r.id === 'chequing-a').value = x.plan.startingCash.breakdown[0].value;
  return F.billsAccountPeriodBalance(x.plan, x.asOf, x.opts);
}
const txs = x => x.opts.currentPeriodActuals.transactions;
const bills = (x, delta) => { x.plan.startingCash.breakdown[0].value = Math.round((x.plan.startingCash.breakdown[0].value + delta) * 100) / 100; };
const buy = (id, amt, account = 'chequing-a', date = '2026-08-19') => fx.tx(id, account, date, amt, 'Groceries');
const refund = (id, amt, account = 'chequing-a', date = '2026-08-20') => fx.tx(id, account, date, -amt, 'Groceries');

console.log('=== 1. baseline and plain purchase ===');
const base = close();
ok(near(BASE_CLOSE, 959.62) && near(base.amount, BASE_CLOSE), 'baseline close is the hand-computed 959.62', String(base.amount));
const plain = close(x => { txs(x).push(buy('inv-buy', 50)); bills(x, -50); });
ok(near(plain.amount, BASE_CLOSE), 'a 50 Bills purchase inside target leaves the close at 959.62', String(plain.amount));

console.log('\n=== 2. purchase plus full refund round-trips ===');
const round = close(x => { txs(x).push(buy('inv-buy', 50), refund('inv-refund', 50)); });
ok(near(round.amount, BASE_CLOSE), 'purchase 50 + refund 50 closes at 959.62, not 1009.62', String(round.amount));
ok(near(round.household.funded, 0), 'the refunded purchase is no longer counted as funded', String(round.household.funded));

console.log('\n=== 3. partial refund conserves net spend ===');
const partial = close(x => { txs(x).push(buy('inv-buy', 50), refund('inv-refund', 20)); bills(x, -30); });
ok(near(partial.amount, BASE_CLOSE) && near(partial.household.funded, 30),
  'purchase 50 − refund 20 funds net 30 and closes at 959.62', `${partial.amount} / ${partial.household.funded}`);

console.log('\n=== 4. overspend: 150 − 50 refunded equals a plain 100 ===');
const over = close(x => { txs(x).push(buy('inv-big', 100)); bills(x, -100); });
const overRefunded = close(x => { txs(x).push(buy('inv-big', 150), refund('inv-refund', 50)); bills(x, -100); });
ok(near(OVER_CLOSE, 930.75) && near(over.amount, OVER_CLOSE), 'plain 100 overspend closes at 930.75', String(over.amount));
ok(near(overRefunded.amount, OVER_CLOSE), '150 with 50 refunded closes at the same 930.75 (not 960.02)', String(overRefunded.amount));
ok(near(overRefunded.household.target, over.household.target), 'the hold (target) is the same net-spend hold');

console.log('\n=== 5. a refund of an earlier purchase restores that category\'s budget, once ===');
// Budget Spent nets the refund (spent −20, remaining = 71.13 + 20), so the
// Bills close holds the restored budget instead of releasing it as free cash.
const prior = close(x => { txs(x).push(refund('inv-refund', 20)); bills(x, 20); });
ok(near(prior.amount, BASE_CLOSE), 'refund 20 into Bills with no in-period purchase: cash +20, hold +20, close 959.62', String(prior.amount));

console.log('\n=== 6. controls: no Bills cash path is changed ===');
const weekly = close(x => { txs(x).push(buy('inv-buy', 50, 'chequing-b'), refund('inv-refund', 50, 'chequing-b')); });
ok(near(weekly.amount, BASE_CLOSE), 'a Weekly purchase + refund leaves the Bills close at 959.62', String(weekly.amount));
const card = close(x => { txs(x).push(buy('inv-buy', 50, 'travelvisa'), refund('inv-refund', 50, 'travelvisa')); });
ok(card.amount === null && card.issues.some(i => i.code === 'card-coverage-unavailable'),
  'an unreconciled card purchase + refund still withholds (unchanged fail-closed)');

console.log('\n' + (failures ? `${failures} failure(s)` : 'All A18 Bills close refund conservation checks passed'));
process.exit(failures ? 1 : 0);
