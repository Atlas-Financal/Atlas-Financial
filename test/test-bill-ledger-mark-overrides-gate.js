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

console.log('6. Off its due date a mark adds no match: a marked debit stays spending beside the reserved bill');
{
  // Grok Bot's ruling: a mark only lifts the 1.5x refusal on a match the
  // rule already makes. The default rule matches the due day only, so a
  // marked debit two days late is not matched. The near-due hold never takes
  // a marked debit (a hold counts only up to the reserve), so it is counted
  // in full as spending while the bill stays reserved: cautious, as on base,
  // and nothing that left the account disappears (#1106 reviews).
  for (const [amount, bad] of [[180, 720], [1000, -100], [120, 780]]) {
    const r = run({ bills: [{ ...WATER }], asOf: '2026-10-14',
      txs: [debit('2026-10-14', amount, { notes: 'item: Invented water' })] });
    ok(r.represented('water').length === 0 && toConfirm(r.bill('water'), 100),
      `${amount} two days late with the note: not matched, the bill stays To confirm at 100`, desc(r.bill('water')));
    ok(r.named('water').length === 0 && r.spending() === 1, `${amount}: not held; counted once as spending`);
    ok(r.bad === bad, `${amount}: balance after deductions ${bad} = 1,400 - 100 reserved - 400 hold - ${amount} spent`, String(r.bad));
  }
  // Without a mark, #1070 is unchanged: above the bound, not named, spending.
  const bare = run({ bills: [{ ...WATER }], asOf: '2026-10-14', txs: [debit('2026-10-14', 180)] });
  ok(bare.named('water').length === 0 && bare.spending() === 1 && toConfirm(bare.bill('water'), 100),
    'without a mark it is not named and stays spending (#1070)', desc(bare.bill('water')));
  ok(bare.bad === 720, 'and balance after deductions is 720 = 1,400 - 100 reserved - 400 hold - 180 spent', String(bare.bad));
  // An unmarked debit within the bound keeps #1070's possible-payment hold.
  const held = run({ bills: [{ ...WATER }], asOf: '2026-10-14', txs: [debit('2026-10-14', 120)] });
  ok(held.named('water').length === 1 && held.spending() === 0 && toConfirm(held.bill('water'), 100),
    'an unmarked 120 two days late is still held To confirm (#1070 unchanged)', desc(held.bill('water')));
}

console.log('6b. The mark adds no date reach at any distance');
{
  for (const [asOf, label] of [['2026-10-13', 'one day late'], ['2026-10-15', 'three days late'], ['2026-10-16', 'four days late']]) {
    const r = run({ bills: [{ ...WATER }], asOf, txs: [debit(asOf, 180, { notes: 'item: Invented water' })] });
    ok(r.represented('water').length === 0 && r.named('water').length === 0 && r.spending() === 1 && r.bad === 720,
      `${label}: not matched, not held, spending; 720`, `${desc(r.bill('water'))} ${r.bad}`);
  }
}

console.log('6c. Same day, competing debits');
{
  // One marked among several: the marked debit is the payment, the other
  // stays ordinary spending. 1,400 - 180 paid - 400 hold - 100 spent = 720.
  const one = run({ bills: [{ ...WATER }],
    txs: [debit('2026-10-12', 180, { notes: 'item: Invented water' }), debit('2026-10-12', 100)] });
  ok(one.represented('water').length === 1 && paid(one.bill('water')), 'marked 180 + unmarked 100: the marked one settles the bill',
    JSON.stringify(one.represented('water').map(a => a.actual)));
  ok(one.named('water').length === 0 && one.spending() === 1, 'the unmarked 100 stays spending, counted once');
  ok(one.bad === 720, 'balance after deductions 720', String(one.bad));
  // Two marked debits for one occurrence: not guessed. The bill stays to
  // confirm at its 100 reserve and both are counted in full as spending,
  // never held: 1,400 - 100 reserved - 400 hold - 360 spent = 540.
  const two = run({ bills: [{ ...WATER }],
    txs: [debit('2026-10-12', 180, { notes: 'item: Invented water' }), debit('2026-10-12', 180, { notes: 'item: Invented water' })] });
  ok(two.represented('water').length === 0 && two.bill('water') && two.bill('water').status !== 'PAID',
    'two marked 180s: neither settles the bill', desc(two.bill('water')));
  ok(two.named('water').length === 0 && two.spending() === 2, 'neither is held; both are spending');
  ok(two.bad === 540, 'balance after deductions 540: nothing that left the account disappears', String(two.bad));
  // The same, two days late.
  const late = run({ bills: [{ ...WATER }], asOf: '2026-10-14',
    txs: [debit('2026-10-14', 1000, { notes: 'item: Invented water' }), debit('2026-10-14', 1000, { notes: 'item: Invented water' })] });
  ok(late.represented('water').length === 0 && late.named('water').length === 0 && late.spending() === 2,
    'two marked 1,000s two days late: neither settles, neither is held', String(late.bad));
  ok(late.bad === -1100, 'balance after deductions -1,100 = 1,400 - 100 - 400 - 2,000', String(late.bad));
  // Within the bound too: two marked 120s two days late are not held under
  // #1070's cap either (which would hold one at the reserve and lose 20).
  // 1,400 - 100 reserved - 400 hold - 240 spent = 660.
  const within = run({ bills: [{ ...WATER }], asOf: '2026-10-14',
    txs: [debit('2026-10-14', 120, { notes: 'item: Invented water' }), debit('2026-10-14', 120, { notes: 'item: Invented water' })] });
  ok(within.represented('water').length === 0 && within.named('water').length === 0 && within.spending() === 2,
    'two marked 120s two days late: neither settles, neither is held');
  ok(within.bad === 660, 'balance after deductions 660', String(within.bad));
}

console.log('8. A pending debit never takes a ledger mark: exactly as on base (#1106 Atlas review)');
{
  // Atlas's eight combinations: note or category mark, due day or two days
  // late, 180.37 or 1,000, all pending, observed Oct 16. Base (no mark
  // logic) reads each as a pending debit above the bound: not settled, the
  // bill To confirm at its 100 reserve, the debit counted as spending.
  // 1,400 - 100 reserved - 400 hold - the debit.
  for (const mark of ['note', 'category']) {
    for (const date of ['2026-10-12', '2026-10-14']) {
      for (const amount of [180.37, 1000]) {
        const extra = mark === 'note' ? { notes: 'item: Invented water', pending: true } : { pending: true };
        const r = run({ bills: [{ ...WATER, ...(mark === 'category' ? { budgetCategory: 'utilities' } : {}) }],
          withUtilities: mark === 'category', asOf: '2026-10-16', txs: [debit(date, amount, extra)] });
        const bad = Math.round((1400 - 100 - 400 - amount) * 100) / 100;
        const tag = `${mark}, ${date === '2026-10-12' ? 'due day' : 'two days late'}, pending ${amount}`;
        ok(r.represented('water').length === 0 && r.bill('water') && r.bill('water').status !== 'PAID',
          `${tag}: not settled, never Paid`, desc(r.bill('water')));
        ok(r.bad === bad, `${tag}: balance after deductions ${bad} (base)`, String(r.bad));
      }
    }
  }
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
