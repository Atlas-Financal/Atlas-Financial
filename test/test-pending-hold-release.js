'use strict';
/* A pending authorization hold and its release count as neither spending nor a separate line, on the Stack card and in
 * every Budget category, by one shared Forecast decision (owner decision, Dale, 2026-11-23, #821 7089360610: "It just
 * needs to be clean"; a narrow, owner-directed exception to rule 17's "no matching", for pending rows only; dispatched
 * by ATLAS LEAD 12).
 *
 * The rule (Forecast.pendingHoldReleases):
 *   (A) a pending charge and a pending credit of exactly equal and opposite amount, on the same account, dated within 7
 *       days of each other, where the credit is uncategorized or carries the charge's own ledger category (lead ruling
 *       (b): in the live ledger the release carries its hold's category). Both legs are dropped. A credit in another
 *       category, or with payment or refund identity, is never consumed; a posted refund stays unlinked (LEDGER A).
 *   (B) a pending charge superseded by a posted charge from the same merchant on the same account, 0-7 days later,
 *       within the larger of 20% and $25: the pending hold is dropped, the posted charge counts.
 *   Posted rows are never paired with each other. Ambiguity resolves deterministically.
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
const fx = require('./fixtures/stack-card-week');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const cents = v => Math.round(Number(v) * 100);

// The decided shape (invented amounts): a 118.30 authorization hold and its -118.30 release, the real
// 116.85 grocery charge, and an unrelated 14.60 charge in another category.
const HOLD = 118.30, REAL = 116.85, OTHER = 14.60;
// By hand: the card's new charges are the real charge and the unrelated one, 116.85 + 14.60 = 131.45.
const NEW_CHARGES = 131.45;
ok(cents(REAL + OTHER) === cents(NEW_CHARGES), 'hand arithmetic: 116.85 + 14.60 = 131.45');

const row = (id, amount, { pending = true, date = '2026-08-20', account = 'travelvisa', category = 'Groceries', ...extra } = {}) => ({
  id, coverageRef: 'invented-' + id, atlasAccountId: account, account, accountRole: 'revolving-credit',
  date, amount, currency: 'cad', displayedPayee: 'Example ' + id, categoryLabel: category, pending,
  pendingTreatment: pending ? 'unresolved' : 'confirmed-settled',
  savingsPostingEvidence: pending ? 'pending' : 'posted', ...extra });
const shape = () => [
  row('hold', HOLD, { date: '2026-08-19' }),
  row('release', -HOLD, { date: '2026-08-20', category: null }),
  row('real', REAL, { date: '2026-08-20' }),
  row('other', OTHER, { date: '2026-08-20', category: 'Restaurants' }),
];
const pairsOf = txs => F.pendingHoldReleases({ transactions: txs }).pairs.map(p => p.chargeId + '+' + p.creditId);

console.log('1. The decision');
{
  ok(JSON.stringify(pairsOf(shape())) === JSON.stringify(['hold+release']), "the decided shape: the hold and its release are one pair; the real and unrelated charges are not legs", JSON.stringify(pairsOf(shape())));
  ok(pairsOf([row('hold', HOLD), row('release', -HOLD, { category: 'Groceries' })]).length === 1,
    "a release carrying the hold's own category (Groceries) is consumed: the live ledger's shape (ruling (b))");
  ok(pairsOf([row('hold', HOLD), row('refund', -HOLD, { category: 'Restaurants' })]).length === 0,
    'a same-amount credit in a different category than the charge is not consumed');
  ok(pairsOf([row('hold', HOLD, { category: null }), row('refund', -HOLD, { category: 'Groceries' })]).length === 0,
    'a categorized credit beside an uncategorized charge is not consumed (no shared category)');
  ok(pairsOf([row('hold', HOLD), row('release', -HOLD - 0.01, { category: 'Groceries' })]).length === 0,
    'a same-category credit one cent off is not consumed');
  ok(pairsOf([row('hold', HOLD), row('release', -HOLD, { category: null, currency: 'usd' })]).length === 0
    && pairsOf([row('hold', HOLD), row('release', -118.305, { category: null })]).length === 0,
    'a non-CAD or fractional-cent row is never a leg (the card publication withholds it instead)');
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
  const cash = { accountRole: 'household-cash', account: 'chequing-a', atlasAccountId: 'chequing-a' };
  ok(pairsOf([row('hold', HOLD, cash), row('release', -HOLD, { ...cash, category: null })]).length === 0,
    'card accounts only: a pending pair on household cash (a bill payment, a transfer) is never consumed');
  ok(F.pendingHoldReleases({ transactions: [row('hold', HOLD, { ...cash, displayedPayee: 'Hydro', originalMerchant: 'Hydro' }),
    row('final', REAL, { ...cash, pending: false, displayedPayee: 'Hydro', originalMerchant: 'Hydro' })] }).superseded.length === 0,
    'card accounts only: a pending and a posted payment on household cash are never superseded (a genuine second payment)');
  const grow = { transactions: [row('hold', HOLD)] };
  const first = F.pendingHoldReleases(grow).pairs.length;
  grow.transactions.push(row('release', -HOLD, { category: null }));
  ok(first === 0 && F.pendingHoldReleases(grow).pairs.length === 1, 'a row added to the same packet after a first read is seen (no stale decision)');
  ok(pairsOf([row('dup', HOLD, { pendingPostedDuplicate: true }), row('release', -HOLD, { category: null })]).length === 0,
    'a pending row already in the pending/posted pairing is never a leg');
}

console.log('1b. Only card purchases are legs: issuer charges, bills, transfers and payments are never consumed');
{
  const kinds = [
    ['an interest charge', { categoryLabel: 'Interest charge', displayedPayee: 'INTEREST CHARGE -PURCHASE' }],
    ['a finance-charge hint', { kindHint: 'finance-charge' }],
    ['a represented card bill', { categoryLabel: 'Bills', representedBill: true }],
    ['an excluded-from-totals transfer', { categoryLabel: 'Transfer', kindHint: 'transfer', excludeFromTotals: true }],
    ['a card-payment identity', { cardPaymentIdentity: true }],
  ];
  for (const [label, fields] of kinds) {
    ok(pairsOf([row('charge', HOLD, fields), row('credit', -HOLD, fields)]).length === 0,
      label + ' and its exact opposite pending credit are not a hold and its release');
  }
  const store = { displayedPayee: 'Example warehouse', originalMerchant: 'Example warehouse' };
  ok(F.pendingHoldReleases({ transactions: [row('hold', HOLD, store),
    row('fee', REAL, { ...store, pending: false, pendingTreatment: 'confirmed-settled', kindHint: 'finance-charge' })] }).superseded.length === 0,
    'a posted issuer charge never supersedes a purchase hold');
  ok(pairsOf([row('hold', HOLD), row('release', -HOLD, { category: null })]).length === 1, 'control: an ordinary purchase pair still is one');
}

console.log('2. The Stack card: the pair is neither listed nor counted, and Spent is not withheld for it');
// The fixture week: Travel's posted Spent is 172.40 + 28.75 + 6.25 (interest) = 207.40.
const BASE_SPENT = 207.40;
function card(extra) {
  const x = fx.fixture();
  x.packet.transactions = x.packet.transactions.filter(tx => tx.id !== 'pending-a').concat(extra);
  const pub = F.cardPeriodMovements(x.plan, x.debts, x.asOf, x.window,
    { currentPeriodActuals: x.packet, cardPeriodBalanceEvidence: x.balanceEvidence, liveOverlay: x.overlay });
  return { pub, travel: F.stackCardSummary(pub).find(c => c.id === 'travelvisa') };
}
{
  const { travel } = card(shape());
  ok(travel.spent.amount !== null && cents(travel.spent.amount) === cents(BASE_SPENT + NEW_CHARGES),
    "the decided shape: Spent is 207.40 + 131.45 = 338.85, the hold and its release counted as neither", JSON.stringify(travel.spent));
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
      { id: 'restaurants', label: 'Dining', class: 'discretionary', from: ['Restaurants', 'Fast Food'], plannedPayday: 200, ownerLine: 'Eating out' },
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
  const b = budget(shape());
  ok(cents(b.groceries.spent) === cents(REAL), "the decided shape: Groceries counts the real 116.85 only, never the 118.30 hold", String(b.groceries.spent));
  ok(cents(b.restaurants.spent) === cents(OTHER), 'the unrelated 14.60 counts in its own category', String(b.restaurants.spent));
  const recon = b.rows.flatMap(r => r.recon || []).map(r => r.id);
  ok(!recon.includes('hold') && !recon.includes('release'), 'neither leg is a line in any category', JSON.stringify(recon));
  ok(!b.other || !(b.other.recon || []).some(r => r.id === 'release' || r.id === 'hold'), 'neither leg lands in Other spending');
  const control = budget(shape().filter(tx => tx.id !== 'release'));
  ok(cents(control.groceries.spent) === cents(HOLD + REAL),
    'control: without the release, the pending hold counts as the coming charge, 118.30 + 116.85 = 235.15', String(control.groceries.spent));
  const other = budget([row('hold', HOLD), row('refund', -HOLD, { category: 'Restaurants' })]);
  ok(cents(other.groceries.spent) === cents(HOLD),
    'a same-amount credit in a different category is not consumed: the Groceries hold still counts', String(other.groceries.spent));
  // A posted standalone categorized refund is untouched (LEDGER A item 3): it never nets a category, it is listed apart.
  const posted = budget([row('buy', 50, { pending: false }), row('back', -50, { pending: false })]);
  ok(cents(posted.groceries.spent) === cents(50), 'a posted categorized refund stays unlinked: Groceries still counts the 50.00 purchase', String(posted.groceries.spent));
  // The live ledger's four-row shape (invented amounts), the release categorized Groceries like its hold, plus an
  // earlier posted 61.20 grocery charge on another account. By hand: Groceries = 61.20 + 116.85 = 178.05 (the hold
  // and its release both dropped); Restaurants = 14.60 (Fast Food).
  const live = () => [row('earlier', 61.20, { pending: false, account: 'otherVisa' }), row('real', REAL), row('hold', HOLD),
    row('release', -HOLD, { category: 'Groceries' }), row('sandwich', OTHER, { category: 'Fast Food' })];
  const lb = budget(live());
  ok(cents(lb.groceries.spent) === cents(178.05), "the four-row shape: Groceries 61.20 + 116.85 = 178.05, both legs dropped", String(lb.groceries.spent));
  ok(cents(lb.restaurants.spent) === cents(OTHER), "the four-row shape: the unrelated 14.60 (Fast Food) counts in Eating out", String(lb.restaurants.spent));
  const lc = card(live().filter(tx => tx.id !== 'earlier').map(tx => ({ ...tx, date: '2026-08-20' }))).travel;
  ok(cents(lc.spent.amount) === cents(BASE_SPENT + NEW_CHARGES) && !lc.spent.reasons.includes('card-credit-purpose-unconfirmed'),
    "the four-row shape: Travel new charges 14.60 + 116.85 = 131.45 over the fixture's 207.40, not withheld", JSON.stringify(lc.spent));
}

console.log("3b. Dale's timeline: one number per purchase at every stage (hold -> release -> final)");
{
  const store = { displayedPayee: 'Example warehouse', originalMerchant: 'Example warehouse' };
  const stages = [
    ['1. hold only', [row('hold', HOLD, store)], HOLD],
    ['2. hold + its release + the pending final', [row('hold', HOLD, store), row('release', -HOLD, { ...store, category: 'Groceries' }),
      row('final', REAL, store)], REAL],
    ['3. hold still pending + the posted final', [row('hold', HOLD, store), row('final', REAL, { ...store, pending: false })], REAL],
    ['4. only the posted final', [row('final', REAL, { ...store, pending: false })], REAL],
  ];
  for (const [label, txs, want] of stages) {
    const g = budget(txs).groceries;
    ok(cents(g.spent) === cents(want), label + ': Groceries ' + want, String(g.spent));
    const t = card(txs.map(tx => ({ ...tx, date: '2026-08-20' }))).travel;
    ok(cents(t.spent.amount) === cents(BASE_SPENT + want), label + ': Travel new charges 207.40 + ' + want, JSON.stringify(t.spent));
  }
}

console.log('4a. One native id, one row (review 7089951090, finding 3)');
{
  // A release whose id the packet carries twice, beside two distinct equal holds: no pair, both holds still count.
  const dup = [row('hold-a', HOLD, { date: '2026-08-19' }), row('hold-b', HOLD, { date: '2026-08-19' }),
    row('release', -HOLD, { date: '2026-08-20', category: null }), row('release', -HOLD, { date: '2026-08-20', category: null })];
  const r = F.pendingHoldReleases({ transactions: dup });
  ok(r.pairs.length === 0 && r.legs.size === 0, 'a repeated release id consumes nothing, so neither distinct hold is hidden', JSON.stringify(r.pairs));
  const g = budget(dup).groceries;
  ok(cents(g.spent) === cents(HOLD + HOLD), 'Budget: both distinct holds still count, 118.30 + 118.30 = 236.60', String(g.spent));
  ok(F.pendingHoldReleases({ transactions: [row('hold', HOLD), row('hold', HOLD), row('release', -HOLD, { category: null })] }).pairs.length === 0,
    'a repeated charge id is never a leg either');
}

console.log('4. (B) A pending hold superseded by its posted final charge');
{
  const posted = (id, amount, extra = {}) => row(id, amount, { pending: false, ...extra });
  const sup = txs => F.pendingHoldReleases({ transactions: txs }).superseded.map(p => p.pendingId + '>' + p.postedId);
  // Same merchant (the row helper's payee is per id, so give both legs one merchant name).
  const store = { displayedPayee: 'Example warehouse', originalMerchant: 'Example warehouse' };
  ok(JSON.stringify(sup([row('hold', HOLD, { date: '2026-08-19', ...store }), posted('final', REAL, { date: '2026-08-20', ...store })])) === JSON.stringify(['hold>final']),
    'a posted 116.85 from the same merchant and account, a day later, supersedes the 118.30 hold');
  ok(sup([row('hold', HOLD, { ...store }), posted('final', REAL, { ...store, displayedPayee: 'Example grocer', originalMerchant: 'Example grocer' })]).length === 0,
    'a different merchant does not supersede');
  ok(sup([row('hold', HOLD, { ...store }), posted('final', REAL, { ...store, account: 'otherVisa' })]).length === 0,
    'another account does not supersede');
  // Review 7089951090, finding 2: only a row the ledger itself posted is a final, in CAD and whole cents.
  ok(sup([row('hold', HOLD, { ...store }), row('final', REAL, { ...store, pendingTreatment: 'presumed-settled-for-current-forecast' })]).length === 0,
    'a second pending row Forecast only presumes settled is not a posted final: the hold is not superseded');
  // Review 7092825238: the observer emits pending false with posting evidence 'unknown' when the source's posting
  // evidence is missing or unqualified. Only native posted evidence ('posted') makes a final.
  ok(sup([row('hold', HOLD, { ...store }), posted('final', REAL, { ...store, savingsPostingEvidence: 'unknown' })]).length === 0,
    'a non-pending row whose posting evidence is unknown is not a posted final: the hold is not superseded');
  {
    const noEvidence = posted('final', REAL, { ...store }); delete noEvidence.savingsPostingEvidence;
    ok(sup([row('hold', HOLD, { ...store }), noEvidence]).length === 0, 'a non-pending row with no posting evidence is not a posted final');
    ok(sup([row('hold', HOLD, { ...store }), posted('final', REAL, { ...store, savingsPostingEvidence: 'posted' })]).length === 1,
      'control: pending false with posting evidence posted supersedes');
    const g = budget([row('hold', HOLD, store), posted('final', REAL, { ...store, savingsPostingEvidence: 'unknown' })]).groceries;
    ok(budget([row('hold', HOLD, store), posted('final', REAL, { ...store, savingsPostingEvidence: 'unknown' })]).rows
      .flatMap(r => r.recon || []).some(r => r.id === 'hold'), 'Budget: beside an unknown-evidence final the hold is still a counted line', String(g.spent));
  }
  ok(sup([row('hold', HOLD, { ...store }), posted('final', REAL, { ...store, currency: 'usd' })]).length === 0,
    'a foreign-currency posted row does not supersede a CAD hold');
  ok(sup([row('hold', HOLD, { ...store }), posted('final', 116.855, { ...store })]).length === 0,
    'a posted row with fractional cents does not supersede');
  ok(sup([row('hold', HOLD, { ...store }), posted('final', REAL, { ...store, currency: 'CAD' })]).length === 1,
    'control: a genuine posted CAD final does supersede');
  // Review 7090113373: the card publication's own money qualification (Forecast's cardMoneyCents) gates both rules.
  const unqualified = [['a missing currency', { currency: undefined }], ['a currency conflict flag', { coverageCurrencyConflict: true }],
    ['an unconfirmed settlement flag', { currencySettlementUnconfirmed: true }]];
  for (const [label, flaw] of unqualified) {
    ok(sup([row('hold', HOLD, { ...store }), posted('final', REAL, { ...store, ...flaw })]).length === 0,
      'a posted final with ' + label + ' does not supersede a valid CAD hold');
    ok(pairsOf([row('hold', HOLD), row('release', -HOLD, { category: null, ...flaw })]).length === 0,
      'a release with ' + label + ' is not consumed, so the valid CAD hold stays');
    const bb = budget([row('hold', HOLD, store), posted('final', REAL, { ...store, ...flaw })]);
    const ids = bb.rows.flatMap(r => r.recon || []).map(r => r.id);
    ok(ids.includes('hold'), 'Budget: beside a final with ' + label + ', the valid hold is still a counted line', JSON.stringify(ids));
  }
  ok(sup([row('hold', HOLD, { ...store }), posted('final', REAL, { ...store }), posted('final', REAL, { ...store, date: '2026-08-21' })]).length === 0,
    'a posted id the packet carries twice supersedes nothing');
  {
    const g = budget([row('hold', HOLD, store), row('final', REAL, { ...store, pendingTreatment: 'presumed-settled-for-current-forecast' })]).groceries;
    ok(cents(g.spent) === cents(HOLD + REAL), 'Budget: beside a presumed-settled pending row the hold still counts, 118.30 + 116.85 = 235.15', String(g.spent));
  }
  ok(sup([row('hold', HOLD, { date: '2026-08-20', ...store }), posted('final', REAL, { date: '2026-08-19', ...store })]).length === 0,
    'a posted charge dated before the hold does not supersede it');
  ok(sup([row('hold', HOLD, { date: '2026-08-10', ...store }), posted('final', REAL, { date: '2026-08-18', ...store })]).length === 0
    && sup([row('hold', HOLD, { date: '2026-08-11', ...store }), posted('final', REAL, { date: '2026-08-18', ...store })]).length === 1,
    'the window is 0 to 7 days after the hold, inclusive');
  // Tolerance: the larger of 20% of the pending amount and $25. For 50.00: max(10.00, 25.00) = 25.00.
  ok(sup([row('gas', 50, { ...store }), posted('pump', 75, { ...store })]).length === 1
    && sup([row('gas', 50, { ...store }), posted('pump', 75.01, { ...store })]).length === 0,
    'tolerance on 50.00 is $25 (larger than 20%): 75.00 supersedes, 75.01 does not');
  // For 200.00: max(40.00, 25.00) = 40.00.
  ok(sup([row('big', 200, { ...store }), posted('final', 240, { ...store })]).length === 1
    && sup([row('big', 200, { ...store }), posted('final', 240.01, { ...store })]).length === 0,
    'tolerance on 200.00 is 20% = $40: 240.00 supersedes, 240.01 does not');
  // Two same-merchant pending trips, one posted: the closest amount wins; the other stays pending (documented).
  const two = sup([row('trip-a', 60, { date: '2026-08-18', ...store }), row('trip-b', 100, { date: '2026-08-19', ...store }),
    posted('final', 98, { date: '2026-08-20', ...store })]);
  ok(JSON.stringify(two) === JSON.stringify(['trip-b>final']), 'two trips, one posted: the closest amount is superseded, the other still counts', JSON.stringify(two));
  // Closest amount beats closest date: trip-a is 1.00 off but 2 days earlier; trip-b is 18.00 off but 1 day earlier.
  const amountFirst = sup([row('trip-a', 97, { date: '2026-08-18', ...store }), row('trip-b', 80, { date: '2026-08-19', ...store }),
    posted('final', 98, { date: '2026-08-20', ...store })]);
  ok(JSON.stringify(amountFirst) === JSON.stringify(['trip-a>final']), 'the closest amount wins before the closest date', JSON.stringify(amountFirst));
  const tie = sup([row('a', 100, { date: '2026-08-18', ...store }), row('b', 100, { date: '2026-08-19', ...store }),
    posted('final', 100, { date: '2026-08-20', ...store })]);
  ok(JSON.stringify(tie) === JSON.stringify(['b>final']), 'an amount tie goes to the closest date', JSON.stringify(tie));
  const one = sup([row('a', 100, { date: '2026-08-19', ...store }), row('b', 100, { date: '2026-08-19', ...store }),
    posted('p1', 100, { date: '2026-08-20', ...store }), posted('p2', 100, { date: '2026-08-20', ...store })]);
  ok(one.length === 2 && new Set(one.join('>').split('>')).size === 4, 'one posted charge supersedes at most one hold', JSON.stringify(one));
  ok(sup([row('hold', HOLD, { ...store, pendingPostedDuplicate: true }), posted('final', REAL, { ...store })]).length === 0,
    'the ledger\'s own pending/posted link runs first: a linked pending row is not superseded again');
  const both = F.pendingHoldReleases({ transactions: [row('hold', HOLD, { date: '2026-08-19', ...store }),
    row('release', -HOLD, { date: '2026-08-20', category: null, ...store }), posted('final', REAL, { date: '2026-08-20', ...store })] });
  ok(both.pairs.length === 1 && both.superseded.length === 0, 'a hold already consumed by (A) is never superseded by (B) too');
  const { travel } = card([row('hold', HOLD, { date: '2026-08-19', ...store }), posted('final', REAL, { date: '2026-08-20', ...store })]);
  ok(cents(travel.spent.amount) === cents(BASE_SPENT + REAL), 'Stack card: the superseded hold is not counted, the posted final is (207.40 + 116.85)', JSON.stringify(travel.spent));
  const b = budget([row('hold', HOLD, store), posted('final', REAL, store)]);
  ok(cents(b.groceries.spent) === cents(REAL), 'Budget: Groceries counts the posted 116.85 only', String(b.groceries.spent));
}

console.log('5. The card line shows the ledger payee, never the generic fallback where the ledger has a name');
{
  const { travel } = card([row('real', REAL, { displayedPayee: undefined, originalMerchant: 'Example warehouse' })]);
  ok(travel.transactions.some(t => t.name === 'Example warehouse') && !travel.transactions.some(t => t.name === 'Card transaction'),
    'a pending row with no displayed payee shows its ledger merchant', JSON.stringify(travel.transactions.map(t => t.name)));
  const bare = card([row('real', REAL, { displayedPayee: undefined, originalMerchant: undefined })]).travel;
  ok(bare.transactions.some(t => t.name === 'Card transaction'), 'with no ledger name at all, the generic label stays');
}

console.log(`\nPASS pending hold and release (${checks})`);
