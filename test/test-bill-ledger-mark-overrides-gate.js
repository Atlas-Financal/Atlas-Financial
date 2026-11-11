'use strict';
/* Grok Bot's ruling on #1070 (2026-11-11): "Adjust, don't revert. A ledger
 * item note or bill category should override the 1.5x gate, so a real bill
 * after a price rise isn't counted as spending."
 *
 * #1070 refuses a default-rule debit above 1.5x the bill's scheduled amount.
 * The household's own ledger mark now outranks that bound, on a debit that
 * already carries the bill's payee identity:
 *   - an `item:` note naming the bill (first line, equal to the bill's label
 *     ignoring case and spacing); or
 *   - a Lunch Money category the bill's own budget category maps from.
 * With no mark, #1070 is unchanged. A mark never names a bill on its own.
 *
 * Path: invented raw Lunch Money payload -> live-plan fromObservation
 * (harness) -> packet -> Forecast.recommend. Every expected value is written
 * by hand. Invented numbers only: pay 1,400 on Oct 9; household budget 400
 * (Groceries 300, Restaurants 100); water 100 monthly on the 12th, paid
 * 180 after a price rise (1.8x, above #1070's 1.5x).
 *
 * `node test/test-bill-ledger-mark-overrides-gate.js`
 */
const F = require('../public/forecast.js');
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const payroll = () => H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a',
  payee: 'Invented employer' });
const debit = (date, amount, extra = {}) => H.lm({ date, amount, category: 'Utilities', account: 'chequing-a',
  payee: 'Invented water co', ...extra });
const WATER = { id: 'water', label: 'Invented water', amount: 100, frequency: 'monthly', day: 12,
  confidence: 'confirmed', payee: 'Invented water co' };
const GAS = { id: 'gas', label: 'Invented gas', amount: 60, frequency: 'monthly', day: 20,
  confidence: 'confirmed', payee: 'Invented gas co' };
// A budget category that maps from Lunch Money's "Utilities", planned at 0 so
// the household hold stays 400 in every case.
const UTILITIES = { id: 'utilities', label: 'Utilities', class: 'essential', plannedPayday: 0,
  confidence: 'confirmed', from: ['Utilities'] };

function run({ bills, txs, asOf, withUtilities }) {
  const w = H.baseWorld(asOf);
  w.bills = bills;
  if (withUtilities) w.budget = w.budget.concat([UTILITIES]);
  w.transactions = [payroll()].concat(txs);
  const r = H.observe(w);
  if (r.error) throw r.error;
  const rec = F.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet });
  const periods = (rec.defaultView && rec.defaultView.calendarPeriods) || [];
  const current = periods.find(p => p.start <= w.asOf && p.end >= w.asOf) || periods[0];
  const view = (rec.payPeriodViews || []).find(v => v.start <= w.asOf && v.end >= w.asOf) || {};
  const debits = (r.packet.transactions || []).filter(t => Number(t.amount) > 0);
  const spentTotal = ((current && current.householdBudget) || [])
    .reduce((s, x) => s + (x && typeof x.spent === 'number' ? x.spent : 0), 0);
  return {
    bad: view.balanceAfterDeductions,
    spentTotal,
    bill: id => ((current && current.bills) || []).find(b => b.id === id) || null,
    represented: id => (r.packet.representedActuals || []).filter(a => a.id === id),
    named: id => debits.filter(t => t.nearDueBillCandidate && t.nearDueBillCandidate.id === id),
    spending: () => debits.map(t => F.classifyCurrentPeriodTransaction(t, r.plan,
      { packet: r.packet, currentPeriodActuals: r.packet })).filter(c => c.householdSpending === true).length,
  };
}
const paid = b => !!(b && b.status === 'PAID' && b.settlement === 'represented');
const toConfirm = (b, remaining) => !!(b && b.status !== 'PAID' && b.settlement === 'unverified' && b.remaining === remaining);
const desc = b => b ? `${b.status}/${b.settlement}/${b.remaining}` : 'missing';

console.log('1. Price rise with an item note naming the bill: paid once, not spending');
{
  const r = run({ bills: [{ ...WATER }], txs: [debit('2026-10-12', 180, { notes: 'item: Invented water' })] });
  ok(r.represented('water').length === 1, 'the 180 debit settles the 100 bill', JSON.stringify(r.represented('water').map(a => a.amount)));
  ok(paid(r.bill('water')), 'the water row reads Paid', desc(r.bill('water')));
  ok(r.spending() === 0, 'the 180 is not household spending');
  // #1063: a paid bill's posted actual at or above plan is deducted once.
  ok(r.bad === 820, 'balance after deductions 820 = 1,400 - 180 paid - 400 household hold', String(r.bad));
}
{
  // Case and spacing do not matter; only the first line is read.
  const r = run({ bills: [{ ...WATER }], txs: [debit('2026-10-12', 180, { notes: '  ITEM:   invented   WATER \nsecond line' })] });
  ok(r.represented('water').length === 1 && r.bad === 820, 'the note match ignores case and spacing and reads the first line only', String(r.bad));
}

console.log('2. The same debit without a ledger mark: #1070 unchanged');
{
  const r = run({ bills: [{ ...WATER }], txs: [debit('2026-10-12', 180)] });
  ok(r.represented('water').length === 0, 'the 180 debit does not settle the 100 bill');
  ok(toConfirm(r.bill('water'), 100), 'the water row stays To confirm with 100 reserved', desc(r.bill('water')));
  ok(r.spending() === 1, 'the 180 stays household spending, counted once');
  ok(r.spentTotal === 180, 'the household budget shows 180 spent', String(r.spentTotal));
}

console.log('3. Price rise filed under the bill\'s own category: paid once, not spending');
{
  const r = run({ bills: [{ ...WATER, budgetCategory: 'utilities' }], withUtilities: true,
    txs: [debit('2026-10-12', 180)] });
  ok(r.represented('water').length === 1, 'Utilities maps to the bill\'s budget category: the 180 settles it');
  ok(paid(r.bill('water')), 'the water row reads Paid', desc(r.bill('water')));
  ok(r.spending() === 0, 'the 180 is not household spending');
  ok(r.bad === 820, 'balance after deductions 820', String(r.bad));
}

console.log('4. A mark that is not this bill\'s: #1070 unchanged');
{
  // A category the bill's budget category does not map from.
  const groceries = run({ bills: [{ ...WATER, budgetCategory: 'utilities' }], withUtilities: true,
    txs: [debit('2026-10-12', 180, { category: 'Groceries' })] });
  ok(groceries.represented('water').length === 0 && toConfirm(groceries.bill('water'), 100),
    'filed as Groceries: refused, water stays To confirm', desc(groceries.bill('water')));
  // A note naming a different bill.
  const other = run({ bills: [{ ...WATER }, { ...GAS }], txs: [debit('2026-10-12', 180, { notes: 'item: Invented gas' })] });
  ok(other.represented('water').length === 0 && toConfirm(other.bill('water'), 100),
    'a note naming another bill: refused', desc(other.bill('water')));
  // A note that only mentions the bill inside other words.
  const loose = run({ bills: [{ ...WATER }], txs: [debit('2026-10-12', 180, { notes: 'item: Invented water filter' })] });
  ok(loose.represented('water').length === 0, 'a note that is not exactly the bill\'s label: refused');
  // An unprefixed note is not a ledger mark.
  const plain = run({ bills: [{ ...WATER }], txs: [debit('2026-10-12', 180, { notes: 'Invented water' })] });
  ok(plain.represented('water').length === 0, 'a note without the item: prefix: refused');
  // A bill with no budget category gains nothing from the category.
  const none = run({ bills: [{ ...WATER }], withUtilities: true, txs: [debit('2026-10-12', 180)] });
  ok(none.represented('water').length === 0, 'a bill with no budget category: the category is not its mark');
}

console.log('5. A mark never names a bill on its own');
{
  const r = run({ bills: [{ ...WATER }], txs: [debit('2026-10-12', 180,
    { payee: 'Invented florist', originalName: 'INVENTED FLORIST', notes: 'item: Invented water' })] });
  ok(r.represented('water').length === 0 && r.named('water').length === 0,
    'another payee with the bill\'s note: not settled and not named');
  ok(toConfirm(r.bill('water'), 100) && r.spending() === 1, 'the bill stays reserved and the 180 stays spending', desc(r.bill('water')));
}

console.log('6. Near due: the mark lifts the bound on the possible-payment hold too');
{
  // Paid two days late, observed Oct 14.
  const marked = run({ bills: [{ ...WATER }], asOf: '2026-10-14',
    txs: [debit('2026-10-14', 180, { notes: 'item: Invented water' })] });
  ok(marked.named('water').length === 1, 'the 180 is named as the bill\'s possible payment');
  ok(marked.spending() === 0, 'and held out of household spending');
  const bare = run({ bills: [{ ...WATER }], asOf: '2026-10-14', txs: [debit('2026-10-14', 180)] });
  ok(bare.named('water').length === 0 && bare.spending() === 1, 'without a mark it is not named and stays spending (#1070)');
}

console.log('7. Within the bound nothing changes, mark or not');
{
  const a = run({ bills: [{ ...WATER }], txs: [debit('2026-10-12', 120, { notes: 'item: Invented water' })] });
  const b = run({ bills: [{ ...WATER }], txs: [debit('2026-10-12', 120)] });
  ok(paid(a.bill('water')) && paid(b.bill('water')) && a.bad === b.bad && a.bad === 880,
    '120 (1.2x) settles the bill either way; BAD 880 = 1,400 - 120 - 400', `${a.bad} / ${b.bad}`);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nA ledger mark overrides the 1.5x gate only for its own bill.');
