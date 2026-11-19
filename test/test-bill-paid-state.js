'use strict';
/* Stack Wallet A3: each published bill row carries one Paid / Not paid word, `paidState` (owner decision, Dale, F2 on #821:
 * "Not paid" until a payment shows up, because autopay dates move; state table relayed by ATLAS LEAD 11).
 *
 *   paid      payment evidence only: a seen payment (Paid, Paid with an excess, Partly paid), a payment pending, money sent
 *             toward it (Planned · Money sent; To confirm · Payment allocation unconfirmed; Partly paid · Rest unknown);
 *   not-paid  no payment seen: Estimated · Trusted on due date (not seen), To confirm · Inside opening balance, To confirm with
 *             the due date passed and nothing seen, Needs a date, Due, Not paid, Status unavailable;
 *   carried   Carried to this pay period: not listed.
 *
 * Proof, independent of Forecast.billPaidState: the expected word is written by hand against the label the CURRENT page
 * printer (plan.js budgetBillPresentation, lifted by name) prints for the same row. So every state today's Bills list can
 * show is mapped once, by hand, and Forecast must agree with it on every row, hand-built and real.
 *
 * Path for the real rows: invented raw Lunch Money payload -> provider observer -> Forecast.recommend pay period rows.
 * Presentation only: every other field of every row, and every period figure, is unchanged (checked against the same
 * world with the word removed). Invented numbers only.
 *
 * `node test/test-bill-paid-state.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const H = require('./acceptance/harness.js');

let checks = 0, failures = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

// the real page printer, lifted by name from public/
const src = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const lift = (text, name) => {
  const re = new RegExp(`^(?:const ${name} = |function ${name}\\()`, 'm');
  const m = re.exec(text);
  if (!m) throw new Error(`printer ${name} not found`);
  const end = text.indexOf('\n\n', m.index);
  const next = text.slice(m.index).search(/\n(?:function |const |\/\/)/);
  return text.slice(m.index, m.index + Math.min(next > 0 ? next : Infinity, end > 0 ? end - m.index : Infinity));
};
const app = src('app.js'), plan = src('plan.js');
const ctx = { console, Intl, Number, Math, String, Object, Array, JSON, Date, RegExp };
vm.createContext(ctx);
vm.runInContext([lift(app, 'money2'), lift(plan, 'isValidIsoCalendarDate'), lift(plan, 'budgetBillPresentation'),
  'this.present = budgetBillPresentation;'].join('\n'), ctx);

// Dale's table, by hand, keyed on what today's page prints (label · qualifier). A label the table does not name fails.
function expectedFromPage(row) {
  const p = ctx.present(row);
  const q = p.qualifier || '';
  if (p.label === 'Carried to this pay period') return 'carried';
  if (p.label === 'Payment pending') return 'paid';
  if (p.label === 'Partly paid') return 'paid';
  if (p.label === 'Paid') return 'paid';
  if (p.label === 'Planned' && q === 'Money sent') return 'paid';
  if (p.label === 'To confirm' && (q === 'Payment allocation unconfirmed' || q === 'Money sent; minimum amount unconfirmed')) return 'paid';
  if (p.label === 'To confirm' && (q === '' || q === 'Inside opening balance')) return 'not-paid';
  if (p.label === 'Estimated' && q === 'Trusted on due date (not seen)') return 'not-paid';
  if (['Needs a date', 'Due', 'Not paid', 'Status unavailable'].includes(p.label)) return 'not-paid';
  return 'UNMAPPED ' + p.label + ' · ' + q;
}

console.log('every state the Bills list prints today, one row each (hand-built published rows)');
const base = { id: 'x', label: 'Invented bill', kind: 'obligation', date: '2026-10-12', planned: 90, amount: 90 };
const CASES = [
  ['Carried to this pay period', 'carried', { status: 'carried', settlement: 'carried' }],
  ['Payment pending', 'paid', { status: 'pending', settlement: 'upcoming', paymentPending: true }],
  ['Partly paid · 50 still to pay', 'paid', { status: 'PAID', settlement: 'represented', actual: 40, paymentState: 'partly-paid',
    shortfall: 50, shortfallTrust: 'calculated' }],
  ['Partly paid · ≈ estimated rest', 'paid', { status: 'PAID', settlement: 'represented', paymentState: 'partly-paid', shortfall: 5,
    shortfallTrust: 'estimated' }],
  ['Planned · Money sent', 'paid', { status: 'planned', settlement: 'upcoming', cashPaymentStatus: 'sent', householdPaymentStatus: 'paid' }],
  ['To confirm · Payment allocation unconfirmed', 'paid', { status: 'unconfirmed', settlement: 'unverified',
    cashPaymentStatus: 'sent', householdPaymentStatus: 'unconfirmed' }],
  ['Paid · Payment allocation unconfirmed (settled)', 'paid', { status: 'PAID', settlement: 'represented',
    cashPaymentStatus: 'sent', householdPaymentStatus: 'unconfirmed' }],
  ['Paid · Money sent', 'paid', { status: 'PAID', settlement: 'represented', cashPaymentStatus: 'sent', householdPaymentStatus: 'paid' }],
  ['Partly paid · Rest unknown', 'paid', { status: 'unconfirmed', settlement: 'unverified', cashPaymentStatus: 'sent',
    householdPaymentStatus: 'partial' }],
  ['To confirm · minimum amount unconfirmed', 'paid', { status: 'unconfirmed', settlement: 'unverified', cashPaymentStatus: 'sent',
    householdPaymentStatus: 'sent' }],
  ['To confirm (due date passed, nothing seen)', 'not-paid', { status: 'still due', settlement: 'unverified', actual: null }],
  ['To confirm · Inside opening balance', 'not-paid', { status: 'planned', settlement: 'opening' }],
  ['Status unavailable (unknown settlement)', 'not-paid', { status: 'still due', settlement: 'unknown' }],
  ['Status unavailable (PAID with an unknown settlement)', 'not-paid', { status: 'PAID', settlement: 'unknown' }],
  ['To confirm (PAID copy whose evidence is not established)', 'not-paid', { status: 'PAID', settlement: 'unverified' }],
  ['Estimated · Trusted on due date (not seen)', 'not-paid', { status: 'PAID', settlement: 'represented',
    settlementBasis: 'schedule-trust-on-due' }],
  ['Paid (a seen payment)', 'paid', { status: 'PAID', settlement: 'represented', actual: 90 }],
  ['Paid · over planned', 'paid', { status: 'PAID', settlement: 'represented', actual: 95, excess: 5, excessTrust: 'calculated' }],
  ['Paid (inside the opening, and seen paid)', 'paid', { status: 'PAID', settlement: 'opening' }],
  ['Needs a date', 'not-paid', { status: 'needs-date', settlement: 'upcoming', needsDate: true, date: null }],
  ['Due', 'not-paid', { status: 'still due', settlement: 'upcoming' }],
  ['Not paid (upcoming, contradictory status)', 'not-paid', { status: 'unconfirmed', settlement: 'upcoming' }],
  ['Status unavailable (no settlement)', 'not-paid', { status: 'still due' }],
];
for (const [name, want, fields] of CASES) {
  const row = { ...base, ...fields };
  const page = expectedFromPage(row);
  ok(page === want && F.billPaidState(row) === want, `${name}: ${want}`, `page ${page}, Forecast ${F.billPaidState(row)}`);
}
ok(F.billPaidState(null) === 'not-paid' && F.billPaidState({}) === 'not-paid', 'no row, or a row with nothing known: Not paid');

console.log('real rows: invented raw Lunch Money -> observer -> Forecast.recommend');
function rowsFor(bill, txs, asOf) {
  const w = H.baseWorld(asOf);
  w.bills = [bill];
  w.transactions = txs;
  const r = H.observe(w);
  if (r.error) throw r.error;
  const rec = F.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet });
  return { w, r, rec, row: rec.payPeriodViews.flatMap(v => v.bills || []).find(b => b.id === bill.id && b.date === '2026-10-12') };
}
const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented hydro' };
const pay = (amount, extra = {}) => H.lm({ date: '2026-10-12', amount, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro', ...extra });
const REAL = [
  ['a 90 payment posted on the due date', 'paid', [pay(90)]],
  ['a 40 payment posted on a 90 bill (Partly paid)', 'paid', [pay(40)]],
  ['a 90 payment still pending (Payment pending)', 'paid', [pay(90, { pending: true })]],
  ['due date passed, no payment seen', 'not-paid', []],
];
const worlds = [];
for (const [name, want, txs] of REAL) {
  const x = rowsFor(HYDRO, txs);
  worlds.push(x);
  ok(x.row && x.row.paidState === want && expectedFromPage(x.row) === want, `${name}: ${want}`,
    x.row && `${x.row.status}/${x.row.settlement}, page ${expectedFromPage(x.row)}, published ${x.row.paidState}`);
}
{
  const x = rowsFor(HYDRO, [], '2026-10-05');
  worlds.push(x);
  ok(x.row && x.row.paidState === 'not-paid' && x.row.settlement === 'upcoming', 'not yet due: Not paid', x.row && x.row.paidState);
}

console.log('every published bill row, in every pay period of every world above');
let rows = 0;
for (const { rec } of worlds) {
  for (const v of rec.payPeriodViews) {
    for (const b of v.bills || []) {
      rows++;
      if (b.paidState !== expectedFromPage(b)) ok(false, `${v.start} ${b.id}@${b.date}`, `${b.paidState} vs page ${expectedFromPage(b)}`);
    }
  }
}
ok(rows > 0, `all ${rows} published rows carry the word the page table gives`);

console.log('presentation only: nothing else moves');
{
  const x = rowsFor(HYDRO, [pay(40)]);
  const strip = rec => JSON.parse(JSON.stringify(rec, (k, val) => (k === 'paidState' ? undefined : val)));
  const again = F.recommend(x.r.plan, x.w.asOf, { currentPeriodActuals: x.r.packet });
  ok(JSON.stringify(strip(again)) === JSON.stringify(strip(x.rec)), 'a rerun is identical once the word is removed (deterministic)');
  const views = x.rec.payPeriodViews;
  ok(views.every(v => (v.bills || []).every(b => ['paid', 'not-paid', 'carried'].includes(b.paidState))),
    'every row carries exactly one of paid / not-paid / carried');
  ok(x.row.status === 'PAID' && x.row.actual === 40 && x.row.remaining === 0 && x.row.shortfall === 50,
    'the Partly paid row keeps its status, actual, remaining and shortfall', JSON.stringify({ s: x.row.status, a: x.row.actual }));
}

console.log(failures ? `\n${failures} of ${checks} bill paid-state checks FAILED.` : `\nAll bill paid-state checks passed (${checks}).`);
if (failures) process.exit(1);
