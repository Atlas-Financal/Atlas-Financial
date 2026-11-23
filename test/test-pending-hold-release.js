'use strict';
/* A pending authorization hold and its release count as neither spending nor a separate line, on the Stack card and in
 * every Budget category, by one shared Forecast decision (owner decision, Dale, 2026-11-23, #821 7089360610: "It just
 * needs to be clean"; a narrow, owner-directed exception to rule 17's "no matching", for pending rows only; dispatched
 * by ATLAS LEAD 12).
 *
 * The rule (Forecast.pendingHoldReleases): a pending charge and an uncategorized pending credit of exactly equal and
 * opposite amount, on the same account, dated within 7 days of each other. Posted rows are never paired. A credit the
 * ledger has categorized, or that carries payment or refund identity, is never consumed. Several equal charges for one
 * credit pair with the earliest (date, then id).
 *
 * Failure it detects: a hold and its release counted as spending, or the release withholding the card's Spent; the
 * Stack card and a Budget category disagreeing about the same pair; a categorized refund, an unmatched credit, an
 * out-of-window or cross-account pair, a payment, or a posted pair being consumed; ambiguity resolved other than to the
 * earliest charge. Release decision: any failure blocks.
 *
 * Every expected figure is worked by hand below, never read back from the code under test.
 * Invented data only. `node test/test-pending-hold-release.js`
 */
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const fx = require('./fixtures/card-posted-period-movement-data');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const cents = v => Math.round(Number(v) * 100);

// Dale's shape (invented amounts in his pattern): a 234.61 authorization hold and its -234.61 release, the real
// 232.47 grocery charge, and an unrelated 22.48 charge in another category.
const HOLD = 234.61, REAL = 232.47, OTHER = 22.48;
// By hand: the card's new charges are the real charge and the unrelated one, 232.47 + 22.48 = 254.95.
const DALE_NEW_CHARGES = 254.95;
ok(cents(REAL + OTHER) === cents(DALE_NEW_CHARGES), 'hand arithmetic: 232.47 + 22.48 = 254.95');

const row = (id, amount, { pending = true, date = '2026-08-20', account = 'travelvisa', category = 'Groceries', ...extra } = {}) => ({
  id, coverageRef: 'invented-' + id, atlasAccountId: account, account, accountRole: 'revolving-credit',
  date, amount, currency: 'cad', displayedPayee: 'Example ' + id, categoryLabel: category, pending,
  pendingTreatment: pending ? 'unresolved' : 'confirmed-settled',
  savingsPostingEvidence: pending ? 'pending' : 'posted', ...extra });
const dale = () => [
  row('hold', HOLD, { date: '2026-08-19' }),
  row('release', -HOLD, { date: '2026-08-20', category: null }),
  row('real', REAL, { date: '2026-08-20' }),
  row('other', OTHER, { date: '2026-08-20', category: 'Restaurants' }),
];
const pairsOf = txs => F.pendingHoldReleases({ transactions: txs }).pairs.map(p => p.chargeId + '+' + p.creditId);

console.log('1. The decision');
{
  ok(JSON.stringify(pairsOf(dale())) === JSON.stringify(['hold+release']), "Dale's shape: the hold and its release are one pair; the real and unrelated charges are not legs", JSON.stringify(pairsOf(dale())));
  ok(pairsOf([row('hold', HOLD), row('refund', -HOLD, { category: 'Groceries' })]).length === 0,
    'an unrelated same-amount credit the ledger has categorized is not consumed');
  ok(pairsOf([row('lone', -HOLD, { category: null })]).length === 0, 'a credit with no matching charge is not consumed');
  ok(pairsOf([row('hold', HOLD), row('release', -HOLD - 0.01, { category: null })]).length === 0, 'a credit one cent off is not consumed');
  ok(pairsOf([row('hold', HOLD, { date: '2026-08-10' }), row('release', -HOLD, { date: '2026-08-18', category: null })]).length === 0,
    'a pair 8 days apart (outside the 7-day window) is not consumed');
  ok(pairsOf([row('hold', HOLD, { date: '2026-08-11' }), row('release', -HOLD, { date: '2026-08-18', category: null })]).length === 1,
    'a pair exactly 7 days apart is consumed (the window is inclusive)');
  ok(pairsOf([row('hold', HOLD, { pending: false }), row('release', -HOLD, { pending: false, category: null })]).length === 0,
    'a posted pair is never paired');
  ok(pairsOf([row('hold', HOLD), row('release', -HOLD, { pending: false, category: null })]).length === 0
    && pairsOf([row('hold', HOLD, { pending: false }), row('release', -HOLD, { category: null })]).length === 0,
    'a pending leg beside a posted leg is never paired');
  ok(pairsOf([row('hold', HOLD), row('release', -HOLD, { category: null, account: 'otherVisa' })]).length === 0,
    'a credit on another account is not consumed');
  ok(pairsOf([row('hold', HOLD), row('pay', -HOLD, { category: null, cardPaymentIdentity: true })]).length === 0
    && pairsOf([row('hold', HOLD), row('pay', -HOLD, { category: null, kindHint: 'payment' })]).length === 0
    && pairsOf([row('hold', HOLD), row('ref', -HOLD, { category: null, kindHint: 'refund' })]).length === 0,
    'a credit with payment or refund identity is not consumed');
  ok(pairsOf([row('hold', HOLD), row('release', -HOLD, { category: 'Uncategorized' })]).length === 1,
    'a credit Lunch Money labels Uncategorized is uncategorized');
  const two = pairsOf([row('b-later', HOLD, { date: '2026-08-19' }), row('a-earlier', HOLD, { date: '2026-08-18' }),
    row('release', -HOLD, { date: '2026-08-20', category: null })]);
  ok(JSON.stringify(two) === JSON.stringify(['a-earlier+release']), 'two equal charges and one credit: the earliest charge is paired, the other stays a charge', JSON.stringify(two));
  const tie = pairsOf([row('z', HOLD), row('m', HOLD), row('release', -HOLD, { category: null })]);
  ok(JSON.stringify(tie) === JSON.stringify(['m+release']), 'a same-day tie pairs the lower id, deterministically', JSON.stringify(tie));
  const twice = pairsOf([row('h1', HOLD), row('h2', HOLD), row('r1', -HOLD, { category: null }), row('r2', -HOLD, { category: null })]);
  ok(twice.length === 2 && new Set(twice.join('+').split('+')).size === 4, 'two holds and two releases make two pairs, no leg used twice', JSON.stringify(twice));
  ok(pairsOf([row('dup', HOLD, { pendingPostedDuplicate: true }), row('release', -HOLD, { category: null })]).length === 0,
    'a pending row already in the pending/posted pairing is never a leg');
}

console.log('2. The Stack card: the pair is neither listed nor counted, and Spent is not withheld for it');
// The fixture week: Travel's posted Spent is 172.40 + 63.75 + 6.25 (interest) - 35.00 (refund) = 207.40.
const BASE_SPENT = 207.40;
function card(extra) {
  const x = fx.fixture();
  x.packet.transactions = x.packet.transactions.filter(tx => tx.id !== 'pending-a').concat(extra);
  const pub = F.cardPeriodMovements(x.plan, x.debts, x.asOf, x.window,
    { currentPeriodActuals: x.packet, cardPeriodBalanceEvidence: x.balanceEvidence, liveOverlay: x.overlay });
  return { pub, travel: F.stackCardSummary(pub).find(c => c.id === 'travelvisa') };
}
{
  const { travel } = card(dale());
  ok(travel.spent.amount !== null && cents(travel.spent.amount) === cents(BASE_SPENT + DALE_NEW_CHARGES),
    "Dale's shape: Spent is 207.40 + 254.95 = 462.35, the hold and its release counted as neither", JSON.stringify(travel.spent));
  ok(travel.spent.trust === 'estimated' && !travel.spent.reasons.includes('card-credit-purpose-unconfirmed'),
    'Spent reads estimated (pending rows), never withheld for the consumed release', JSON.stringify(travel.spent));
  const ids = travel.transactions.map(r => r.name);
  ok(!ids.includes('Example hold') && !ids.includes('Example release') && ids.includes('Example real') && ids.includes('Example other'),
    'neither leg is listed as a line; the real and unrelated charges are', JSON.stringify(ids));
  const control = card([row('lone', -50, { category: null })]).travel;
  ok(control.spent.amount === null && control.spent.reasons.includes('card-credit-purpose-unconfirmed'),
    'control: an unmatched uncategorized pending credit still withholds Spent (today\'s behaviour)', JSON.stringify(control.spent));
  const clean = card([row('real', REAL)]).travel;
  ok(cents(clean.spent.amount) === cents(BASE_SPENT + REAL), 'clean control: one pending charge counts as the coming charge (OD-029)');
}

console.log('3. The Budget categories read the same decision');
function budget(txs) {
  const plan = {
    defaults: { targetBuffer: 500 },
    startingCash: { breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 8000 }, { id: 'chequing-b', value: 0 }] },
    opening: { asOf: '2026-08-28', representedEvents: [] },
    income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly', anchor: '2026-08-14', amount: 4264, confidence: 'confirmed' }],
    bills: [], obligations: [], commitments: [],
    budget: { categories: [
      { id: 'groceries', label: 'Groceries', class: 'essential', plannedWeekly: 450, ownerLine: 'Groceries' },
      { id: 'restaurants', label: 'Dining', class: 'discretionary', from: ['Restaurants'], plannedPayday: 200, ownerLine: 'Eating out' },
    ] },
  };
  const packet = { schema: 'atlas-current-period-actuals/v1', observationAsOf: '2026-09-01', coverageStart: '2026-07-01',
    coverageThrough: '2026-09-01', pendingCoverage: 'complete', transactionCoverage: 'complete', representedActuals: [],
    transactions: txs.map(tx => ({ ...tx, date: '2026-09-01' })) };
  const debts = [{ id: 'travelvisa', label: 'Travel Visa', secured: false, structure: 'Revolving', balance: 900, rate: 20, payment: 30, pending: 0 }];
  const view = F.recommend(plan, '2026-09-01', { targetBuffer: 500, debts, currentPeriodActuals: packet, representedEvents: [] });
  const p = (view.defaultView.calendarPeriods || []).find(x => x.id === 'this-pay-period');
  const rows = p.householdBudget || [];
  return { groceries: rows.find(r => r.id === 'groceries'), restaurants: rows.find(r => r.id === 'restaurants'),
    other: rows.find(r => r && r.otherSpending), rows };
}
{
  const b = budget(dale());
  ok(cents(b.groceries.spent) === cents(REAL), "Dale's shape: Groceries counts the real 232.47 only, never the 234.61 hold", String(b.groceries.spent));
  ok(cents(b.restaurants.spent) === cents(OTHER), 'the unrelated 22.48 counts in its own category', String(b.restaurants.spent));
  const recon = b.rows.flatMap(r => r.recon || []).map(r => r.id);
  ok(!recon.includes('hold') && !recon.includes('release'), 'neither leg is a line in any category', JSON.stringify(recon));
  ok(!b.other || !(b.other.recon || []).some(r => r.id === 'release' || r.id === 'hold'), 'neither leg lands in Other spending');
  const control = budget(dale().filter(tx => tx.id !== 'release'));
  ok(cents(control.groceries.spent) === cents(HOLD + REAL),
    'control: without the release, the pending hold counts as the coming charge, 234.61 + 232.47 = 467.08', String(control.groceries.spent));
  const refund = budget([row('hold', HOLD), row('refund', -HOLD, { category: 'Groceries' })]);
  ok(cents(refund.groceries.spent) === cents(HOLD),
    'a same-amount categorized pending credit is not consumed: the hold still counts, the credit keeps today\'s treatment', String(refund.groceries.spent));
}

console.log(`\nPASS pending hold and release (${checks})`);
