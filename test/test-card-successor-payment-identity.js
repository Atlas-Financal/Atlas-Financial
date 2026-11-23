'use strict';
/* Owner facts 2026-11-20 (Dale): Triangle and Amazon carry their schedules on successor rows (triangle-td3,
 * triangle-day8, mbna-auto30). A categorized card payment from Bills must still link to the row that owns the
 * occurrence, through the committed payment-alias rules. Invented ledger: one 49.37 payment against a 43.19
 * statement minimum, $1,000 cash and $800 debt, as in test-card-minimum-category.js. */
const assert = require('node:assert/strict');
const O = require('../scripts/provider-observe');
const Category = require('../scripts/card-minimum-category');
const source = require('./fixtures/card-backfill-data');
const identity = require('../docs/connectivity/transaction-identity.json');
const NOW = '2035-10-06', ORIGINAL = '2035-10-07', DUE = '2035-10-08';
let checks = 0, failures = 0;
const ok = (cond, label, detail) => { checks++; if (cond) console.log('  PASS  ' + label); else { failures++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); } };

function fixture(card, id, rules) {
  const x = source(card, id), name = Object.keys(Category.CATEGORIES).find(k => Category.CATEGORIES[k] === card);
  x.data.meta.asOf = x.data.plan.opening.asOf = '2035-10-01';
  x.data.plan.opening.representedEvents = [];
  x.data.plan.income[0].anchor = '2035-10-01'; x.data.plan.income[0].amount = 0;
  x.data.plan.budget = { categories: [] };
  x.data.plan.obligations = [{ id, debtId: card, effect: 'payment', frequency: 'monthly', day: 7,
    firstDue: ORIGINAL, payingAccount: 'chequing-a', amount: 41.13, confidence: 'estimated',
    statementOccurrences: [{ scheduledDate: ORIGINAL, dueDate: DUE, minimum: 43.19, currency: 'cad', confidence: 'confirmed' }] }];
  x.data.plan.startingCash.breakdown[0].value = 1000;
  x.data.debts[0].balance = 800;
  x.payload.accounts[0].balance = 950.63; x.payload.accounts[3].balance = 750.63;
  x.payload.accounts.forEach(a => { a.updated_at = NOW + 'T17:00:00Z'; a.balance_last_update = NOW + 'T17:00:00Z'; });
  x.payload.fetchedAt = NOW + 'T18:00:00Z';
  x.payload.transactionWindow = { startDate: '2035-10-01', endDate: NOW, complete: true, hasMore: false, truncated: false };
  x.payload.categories = [{ id: 9001, name, is_income: false, is_group: false, exclude_from_totals: true, exclude_from_budget: true }];
  x.payload.transactions = [{ id: 98001, account_id: 3001, date: '2035-10-05', amount: 49.37, currency: 'cad',
    payee: card === 'triangle' ? 'CAN TIRE MC' : 'MBNA M/C', category_id: 9001, is_pending: false, status: 'reviewed' }];
  if (rules) x.identity = { ...identity, rules };
  x.asOf = NOW;
  return x;
}
const payments = x => O.observe({ ...x, provider: 'lunchmoney' }).cardMinimumCategoryEvidence.payments;

for (const [card, id] of [['triangle', 'triangle-td3'], ['triangle', 'triangle-day8'], ['mbna', 'mbna-auto30']]) {
  const got = payments(fixture(card, id));
  ok(got.length === 1,
    `${id}: the categorized 49.37 payment links to the successor row (one payment)`, JSON.stringify(got.map(p => p.cashPaid)));
  const without = identity.rules.filter(rule => rule.eventId !== id);
  ok(payments(fixture(card, id, without)).length === 0,
    `${id}: without its own alias rule nothing links (the rule is what links it)`);
}
ok(payments(fixture('triangle', 'triangle-elsewhere')).length === 0,
  'negative: a Triangle row id with no alias rule gets no payment');
for (const [base, successors] of [['triangle', ['triangle-td3', 'triangle-day8']], ['mbna', ['mbna-auto30']]]) {
  // Recurring links are per row (owner-provided ids, 2026-11-21), not part of the copied alias.
  const strip = rule => { const { eventId, lunchMoneyRecurringIds, ...rest } = rule; return JSON.stringify(rest); };
  const original = identity.rules.filter(r => r.eventId === base).map(strip);
  for (const id of successors) {
    ok(original.length > 0 && JSON.stringify(identity.rules.filter(r => r.eventId === id).map(strip)) === JSON.stringify(original),
      `${id}: alias rules are exact copies of ${base}'s, which are kept for history`);
  }
}

// Grok Bot's conditions (Plan #6, 2026-11-20): one plan row per payment, To confirm when two rows fit,
// the direction filter stays, and a `card payment:` note is never overridden. These hold through the
// existing per-occurrence window (statement close to due + 7), not a new rule field.
console.log('Grok Bot conditions');
const withTx = (x, patch) => { Object.assign(x.payload.transactions[0], patch); return x; };
{
  const at = date => payments(withTx(fixture('triangle', 'triangle-td3'), { date })).length;
  const x = fixture('triangle', 'triangle-td3');
  x.payload.transactionWindow.endDate = '2035-10-20'; x.asOf = '2035-10-20';
  x.payload.accounts.forEach(a => { a.updated_at = '2035-10-20T17:00:00Z'; a.balance_last_update = '2035-10-20T17:00:00Z'; });
  x.payload.fetchedAt = '2035-10-20T18:00:00Z';
  const late = d => { const y = JSON.parse(JSON.stringify(x)); y.payload.transactions[0].date = d; return payments(y).length; };
  ok(at('2035-10-05') === 1, 'boundary: a payment inside the occurrence window links once');
  ok(late('2035-10-15') === 1 && late('2035-10-16') === 0,
    'boundary: due 2035-10-08 + 7 = 10-15 links; 10-16 is outside every row and links to none');
}
{
  const x = fixture('triangle', 'triangle-td3');
  const twin = { ...x.data.plan.obligations[0], id: 'triangle-day8' };
  x.data.plan.obligations.push(twin);
  ok(payments(x).length === 0, 'ambiguous: a payment that fits two rows counts toward neither (To confirm)');
}
ok(payments(withTx(fixture('triangle', 'triangle-td3'), { amount: -49.37 })).length === 0,
  'direction: a credit at the same payee (a store refund or purchase reversal) never links as a payment');
ok(payments(withTx(fixture('triangle', 'triangle-td3'), { notes: 'card payment: TD Cash Back Visa' })).length === 0,
  'note: a `card payment:` note naming another card is not overridden by the Triangle pattern (no count)');


{
  // The committed schedule's lookup windows (statement close before the due, to due + 7) never overlap
  // between rows of one card from the change (Oct 2026 on), so the old rules only ever see payments before the change. Dates only.
  const F = require('../public/forecast');
  const data = require('../data.json');
  // Independent: the last statement close day strictly before the due date.
  const closeBefore = (due, day) => { let d = F.addDays(due, -1);
    while (Number(d.slice(8)) !== Math.min(day, new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).getUTCDate())) d = F.addDays(d, -1);
    return d; };
  for (const card of ['triangle', 'mbna']) {
    const close = data.debts.find(d => d.id === card).statementCloseDay;
    const ids = new Set(data.plan.obligations.filter(r => r.debtId === card && r.effect === 'payment').map(r => r.id));
    const schedule = { ...data.plan, opening: { ...data.plan.opening, representedEvents: [] } };
    const windows = F.expandEvents(schedule, '2026-10-01', '2027-08-31', {})
      .filter(e => e.kind === 'obligation' && ids.has(e.id))
      .map(e => ({ id: e.id, from: closeBefore(e.date, close), due: e.date, to: F.addDays(e.date, 7) }))
      .sort((a, b) => a.due.localeCompare(b.due));
    const overlaps = windows.map((w, i) => i && w.id !== windows[i - 1].id && w.from <= windows[i - 1].to
      ? { before: windows[i - 1], after: w, from: w.from, to: windows[i - 1].to } : null).filter(Boolean);
    // The one dated exception (owner 2026-11-23; Grok Bot, Plan #6, to the lead): "yes to (i), and no ledger
    // objection to moving Nov 30 onto `mbna-auto30` (item 3709492) with the old `mbna` row still ending Oct 31.
    // My conditions: the exception names both rows, covers Nov 6–7, 2026 only, and fails if it ever matches
    // anything else. Neither November payment gets counted against the Nov 30 row's window."
    // The second condition is proved in test-issuer-minimum-payments-reflected.js.
    const excused = o => card === 'mbna' && o.before.id === 'mbna' && o.before.due === '2026-10-31'
      && o.after.id === 'mbna-auto30' && o.after.due === '2026-11-30'
      && o.from === '2026-11-06' && o.to === '2026-11-07';
    const clash = overlaps.filter(o => !excused(o));
    ok(windows.length > 0 && clash.length === 0, `${card}: no two rows' payment windows overlap in the committed schedule`,
      JSON.stringify(clash.map(o => [o.after.id, o.after.due])));
    if (card === 'mbna') {
      ok(overlaps.filter(excused).length === 1,
        'mbna: the one dated exception (mbna@2026-10-31 / mbna-auto30@2026-11-30, 2026-11-06 to 11-07) is the overlap it names');
    }
  }
}


{
  // A card payment from an account the plan excludes (as the Nov 13 Amazon payment from Debt & Payments was) never
  // settles a card occurrence: the categorized matcher takes household-cash (Bills) debits only.
  const x = fixture('mbna', 'mbna-auto30');
  x.payload.transactions[0].account_id = 999999; // invented, mapped to no household account
  ok(payments(x).length === 0, 'excluded account: a categorized Amazon payment from outside household cash leaves the occurrence due');
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
