'use strict';
/* Dog food follows the Lunch Money ledger; its payday cadence restarts
 * at the last purchase (Dale 2026-11-11/12; CLAUDE.md rule 17).
 *
 * A. The Lunch Money recurring-item link (pets.dogFoodLunchMoneyRecurringIds)
 *    is the primary signal; the Lunch Money category is only a second
 *    condition, never enough alone. The original-merchant name match
 *    (SURREY MEAT only) stays only as a fallback for unlinked rows; the
 *    link takes priority. A second merchant spelling (CRUDO BY SURREY)
 *    was dropped on Grok Bot's ruling (2026-11-11, rule 17): no new name
 *    matching, so an unlinked CRUDO BY SURREY row is never Dog food by name.
 * B. The every-other cadence restarts at the last purchase (owner rule,
 *    Dale 2026-11-12): the ON phase is the pay period of the most recent
 *    posted qualifying purchase — the section A ledger rule decides what
 *    qualifies; pending rows and refunds/credits never restart it — and
 *    periods alternate from there. paydayCadenceAnchor governs only when
 *    no qualifying purchase is visible. The one-time paydayCadenceSkips
 *    mechanism this file used to pin is removed.
 *
 * Independent of the helper under change (L-002): the expected ON/OFF
 * schedules are stated outright per scenario, not derived from the code.
 * Amounts on transactions are synthetic.
 *
 * `node test/test-dog-food-lunchmoney-link-and-skip.js`
 */
const F = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');
const liveData = require('../data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const clone = v => JSON.parse(JSON.stringify(v));

const livePlan = liveData.plan;
const livePets = (livePlan.budget.categories || []).find(c => c && c.id === 'pets');
const RECURRING_ID = '3169453';
const CATEGORY_ID = '3237238';
const TX_ID = 2537725312;
const SYN_AMT = 41.23; // synthetic

function addDays(iso, n) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return [dt.getUTCFullYear(), String(dt.getUTCMonth() + 1).padStart(2, '0'),
    String(dt.getUTCDate()).padStart(2, '0')].join('-');
}
const cls = (tx, plan) => F.classifyCurrentPeriodTransaction(tx, plan || livePlan, {});
const why = c => c && `${c.kind}/${c.categoryId}/${c.includeReason || c.reason}`;

console.log('\n=== config: ids live in data.json pets, not in forecast.js ===');
{
  ok(livePets && Array.isArray(livePets.dogFoodLunchMoneyRecurringIds)
      && livePets.dogFoodLunchMoneyRecurringIds.includes(RECURRING_ID),
    'pets.dogFoodLunchMoneyRecurringIds holds the dog food recurring item');
  ok(livePets && Array.isArray(livePets.dogFoodLunchMoneyCategoryIds)
      && livePets.dogFoodLunchMoneyCategoryIds.includes(CATEGORY_ID),
    'pets.dogFoodLunchMoneyCategoryIds holds the Pet supplies category');
  const src = require('fs').readFileSync(require.resolve('../public/forecast.js'), 'utf8');
  ok(!src.includes(RECURRING_ID) && !src.includes(CATEGORY_ID),
    'forecast.js carries no Lunch Money id literal');
}

console.log('\n=== A1. Nov 9 row counts as Dog food through its Lunch Money link ===');
const crudo = {
  id: TX_ID, date: '2026-11-09', amount: SYN_AMT, pending: false, currency: 'cad',
  categoryLabel: 'Pet supplies', categoryId: CATEGORY_ID, recurringId: RECURRING_ID,
  displayedPayee: 'CRUDO BY SURREY _F', originalMerchant: 'CRUDO BY SURREY _F',
  originalName: 'CRUDO BY SURREY _F', accountRole: 'household-cash',
};
{
  const c = cls(crudo);
  ok(c.kind === 'spend' && c.categoryId === 'pets' && c.householdSpending === true
      && !c.needsConfirmation && c.includeReason === 'dog-food-lunchmoney-link',
    'tx 2537725312 (CRUDO BY SURREY _F, recurring 3169453, Pet supplies) is pets via dog-food-lunchmoney-link', why(c));
  const flags = F.classifyCurrentPeriodTransaction.derivedFlags(crudo, livePlan);
  ok(flags.dogFood === true && flags.dogFoodLunchMoneyLink === true,
    'derivedFlags stamps dogFood and dogFoodLunchMoneyLink from the link');
  // Served path: only the boolean stamp travels; the ids are gone.
  const served = Object.assign({}, crudo, flags);
  delete served.recurringId; delete served.categoryId;
  const sc = cls(served);
  ok(sc.categoryId === 'pets' && sc.includeReason === 'dog-food-lunchmoney-link',
    'served row with only the boolean stamp keeps the link reason', why(sc));
}

console.log('\n=== A2. the link decides on its own; the name is only a fallback ===');
{
  const plain = { id: 9001, date: '2026-11-09', amount: SYN_AMT, pending: false, currency: 'cad',
    categoryLabel: 'Pet supplies', categoryId: CATEGORY_ID, recurringId: RECURRING_ID,
    displayedPayee: 'GENERAL STORE 12', originalMerchant: 'GENERAL STORE 12', accountRole: 'household-cash' };
  const c = cls(plain);
  ok(c.categoryId === 'pets' && c.includeReason === 'dog-food-lunchmoney-link',
    'a non-pet merchant name linked to recurring 3169453 is Dog food via the link', why(c));
  const unlinked = Object.assign({}, plain, { recurringId: null });
  const uc = cls(unlinked);
  ok(!(uc.kind === 'spend' && uc.categoryId === 'pets'),
    'the same non-pet row without the link is NOT Dog food', why(uc));
  const uf = F.classifyCurrentPeriodTransaction.derivedFlags(unlinked, livePlan);
  ok(uf.dogFood === false && uf.dogFoodLunchMoneyLink === false, 'without the link no dogFood flag is stamped');
  ok(cls(Object.assign({}, plain, { recurringId: '999' })).categoryId !== 'pets',
    'a different recurring item is not Dog food');
  const noConfig = clone(livePlan);
  delete noConfig.budget.categories.find(cat => cat.id === 'pets').dogFoodLunchMoneyRecurringIds;
  ok(cls(plain, noConfig).categoryId !== 'pets',
    'without the pets config the link counts for nothing (config, not literals)');
  // No CRUDO BY SURREY name fallback (Grok Bot ruling 2026-11-11, rule 17:
  // the second merchant spelling was dropped; no new name matching). Only
  // the recurring link above makes a CRUDO BY SURREY row Dog food.
  const crudoUncat = { date: '2026-11-09', amount: SYN_AMT, categoryLabel: null,
    displayedPayee: 'CRUDO BY SURREY _F', originalMerchant: 'CRUDO BY SURREY _F' };
  const cu = cls(crudoUncat);
  ok(!(cu.kind === 'spend' && cu.categoryId === 'pets') && cu.includeReason !== 'dog-food-merchant',
    'unlinked uncategorised CRUDO BY SURREY _F is NOT Dog food (no name fallback)', why(cu));
  const cp = cls(Object.assign({}, crudoUncat, { categoryLabel: 'Pets' }));
  ok(cp.categoryId !== 'pets' && cp.includeReason !== 'dog-food-merchant'
      && cp.kind === 'unclassified' && cp.reason === 'payee-category-contradiction',
    'unlinked CRUDO BY SURREY _F under Pets is not Dog food (unclassified, payee-category-contradiction)', why(cp));
  ok(cls(Object.assign({}, crudoUncat, { categoryLabel: 'Groceries' })).categoryId === 'groceries',
    'unlinked CRUDO BY SURREY under Groceries stays Groceries (Lunch Money category wins, H1)');
  ok(cls(Object.assign({}, crudoUncat, { displayedPayee: 'CRUDO', originalMerchant: 'CRUDO' })).categoryId !== 'pets',
    'a bare CRUDO name is not Dog food either');
}

console.log('\n=== A3. category is a second condition, never alone ===');
{
  const catOnly = { date: '2026-11-09', amount: SYN_AMT, categoryLabel: 'Pet supplies',
    categoryId: CATEGORY_ID, displayedPayee: 'Hardware Store', originalMerchant: 'HARDWARE STORE' };
  const c = cls(catOnly);
  ok(!(c.kind === 'spend' && c.categoryId === 'pets'), 'Pet supplies alone, non-pet merchant, is not Dog food', why(c));
  const petsLabel = Object.assign({}, catOnly, { categoryLabel: 'Pets', categoryId: '1',
    displayedPayee: 'PETSMART', originalMerchant: 'PETSMART' });
  const pc = cls(petsLabel);
  ok(pc.needsConfirmation === true && pc.reason === 'pets-not-dog-food',
    'Pets label, no link, general pet merchant stays pets-not-dog-food confirmation', why(pc));
  const pcHw = cls(Object.assign({}, catOnly, { categoryLabel: 'Pets', categoryId: '1' }));
  ok(pcHw.needsConfirmation === true && pcHw.categoryId !== 'pets',
    'Pets label, no link, non-pet merchant stays a confirmation row', why(pcHw));
  const linkedGroceries = Object.assign({}, crudo, { categoryLabel: 'Groceries', categoryId: '42' });
  const gc = cls(linkedGroceries);
  ok(gc.categoryId === 'groceries', 'a linked row Lunch Money filed as Groceries stays Groceries', why(gc));
  const linkedPetsAlias = Object.assign({}, crudo, { categoryLabel: 'Pets', categoryId: '7' });
  ok(cls(linkedPetsAlias).includeReason === 'dog-food-lunchmoney-link',
    'a linked row under a category the plan maps to Pets is Dog food');
  const linkedUncat = Object.assign({}, crudo, { categoryLabel: null, categoryId: null });
  ok(cls(linkedUncat).includeReason === 'dog-food-lunchmoney-link',
    'a linked row Lunch Money left uncategorised is Dog food');
}

console.log('\n=== A4. SURREY MEAT fallback keeps current behaviour ===');
{
  const sm = { date: '2026-11-09', amount: SYN_AMT, categoryLabel: 'Pets',
    displayedPayee: 'SURREY MEAT PKR _F', originalMerchant: 'SURREY MEAT PKR _F' };
  const c = cls(sm);
  ok(c.categoryId === 'pets' && c.includeReason === 'dog-food-merchant',
    'unlinked SURREY MEAT under Pets is Dog food via dog-food-merchant', why(c));
  const smUncat = Object.assign({}, sm, { categoryLabel: null });
  ok(cls(smUncat).includeReason === 'dog-food-merchant', 'unlinked uncategorised SURREY MEAT is Dog food');
  const smGroc = Object.assign({}, sm, { categoryLabel: 'Groceries' });
  ok(cls(smGroc).categoryId === 'groceries', 'SURREY MEAT under Groceries stays Groceries (H1, unchanged)');
}

console.log('\n=== A5. observer carries recurring_id but publishes only the boolean ===');
{
  const n = O.normalizeLunchMoneyTransaction({ id: TX_ID, date: '2026-11-09', amount: String(SYN_AMT),
    currency: 'cad', payee: 'Surrey Meat Pkr', original_name: 'CRUDO BY SURREY _F',
    category_id: Number(CATEGORY_ID), recurring_id: Number(RECURRING_ID), account_id: 1001,
    is_pending: false }, new Map([[CATEGORY_ID, { name: 'Pet supplies' }]]), null);
  ok(n.recurringId === RECURRING_ID && n.categoryId === CATEGORY_ID,
    'normalizeLunchMoneyTransaction reads v2 recurring_id as recurringId');
  const n2 = O.normalizeLunchMoneyTransaction({ id: 1, date: '2026-11-09', amount: '1.00' }, null, null);
  ok(n2.recurringId === null, 'absent recurring_id normalizes to null');

  const accountMap = { schema: 'atlas-provider-account-map/v1', mappings: [{ providerAccountId: '1001',
    canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' }] };
  const packet = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-11-11T18:00:00.000Z',
    transactionWindow: { startDate: '2026-11-06', endDate: '2026-11-11', complete: true },
    pendingCoverage: { complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false },
    collapsedTransactions: [{ date: '2026-11-09', amount: SYN_AMT, pending: false,
      savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Pet supplies',
      categoryId: CATEGORY_ID, recurringId: RECURRING_ID, payee: 'Surrey Meat Pkr',
      originalName: 'CRUDO BY SURREY _F', providerAccountId: '1001',
      providerTransactionId: String(TX_ID) }],
    representedEventCandidates: [],
  }, { asOf: '2026-11-11', plan: livePlan, accountMap });
  const rows = (packet && packet.transactions) || [];
  const row = rows.find(r => r && r.date === '2026-11-09');
  ok(row && row.dogFood === true && row.dogFoodLunchMoneyLink === true,
    'served row carries dogFood and dogFoodLunchMoneyLink', row && JSON.stringify({ d: row.dogFood, l: row.dogFoodLunchMoneyLink }));
  const blob = JSON.stringify(packet);
  ok(!blob.includes(RECURRING_ID) && !blob.includes(CATEGORY_ID) && !/recurringId/.test(blob),
    'served packet publishes no raw recurring or category id');
  ok(row && cls(row).includeReason === 'dog-food-lunchmoney-link',
    'Forecast classifies the served row as Dog food via the link', row && why(cls(row)));
}

console.log('\n=== A6. a "Dale" note on a linked row never makes it Dale spend ===');
{
  // The note-based owner parser (provider-observe explicitPersonalOwnerFromTagsNotes,
  // Forecast personalSpendOwner) can stamp personalOwner 'dale' on this row,
  // but classification returns one bucket per row and the Lunch Money link
  // returns Pets before the Personal-shopping owner branch is reached.
  const NOTE = 'Dog food - owner decision (Dale)';
  const noted = Object.assign({}, crudo, { id: 990001, date: '2026-10-05', amount: 17.89, // synthetic
    note: NOTE, notes: NOTE });
  const flags = F.classifyCurrentPeriodTransaction.derivedFlags(noted, livePlan);
  ok(flags.personalOwner === 'dale', 'precondition: the note parser does read "Dale" from this note', String(flags.personalOwner));
  const c = cls(noted);
  ok(c.kind === 'spend' && c.categoryId === 'pets' && c.includeReason === 'dog-food-lunchmoney-link',
    'linked Pet supplies row with a Dale note is Dog food only', why(c));
  const served = Object.assign({}, noted, flags, { personalOwner: 'dale' });
  delete served.recurringId; delete served.categoryId; delete served.note; delete served.notes;
  const sc = cls(served);
  ok(sc.categoryId === 'pets' && sc.includeReason === 'dog-food-lunchmoney-link',
    'served row stamped personalOwner dale still classifies as Dog food, not Dale guilt-free', why(sc));

  const accountMap = { schema: 'atlas-provider-account-map/v1', mappings: [{ providerAccountId: '1001',
    canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' }] };
  const packet = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-11-11T18:00:00.000Z',
    transactionWindow: { startDate: '2026-11-06', endDate: '2026-11-11', complete: true },
    pendingCoverage: { complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false },
    collapsedTransactions: [{ date: '2026-11-08', amount: 17.89, pending: false,
      savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Pet supplies',
      categoryId: CATEGORY_ID, recurringId: RECURRING_ID, payee: 'Surrey Meat Pkr',
      originalName: 'CRUDO BY SURREY _F', notes: NOTE, providerAccountId: '1001',
      providerTransactionId: '990002' }],
    representedEventCandidates: [],
  }, { asOf: '2026-11-11', plan: livePlan, accountMap });
  const row = ((packet && packet.transactions) || []).find(r => r && r.date === '2026-11-08');
  const rc = row && cls(row);
  ok(rc && rc.categoryId === 'pets' && rc.includeReason === 'dog-food-lunchmoney-link'
      && rc.categoryId !== 'dale-guilt-free',
    'observer path: noted linked row is Dog food, never dale-guilt-free', rc && why(rc));

  // Contrast: the same note on an unlinked Personal-shopping row still reads
  // as Dale, so owner attribution for non-dog-food rows is unchanged.
  const personal = { id: 990003, date: '2026-11-08', amount: 12.34, pending: false, currency: 'cad',
    categoryLabel: 'Shopping', displayedPayee: 'SYNTHETIC STORE', originalMerchant: 'SYNTHETIC STORE',
    originalName: 'SYNTHETIC STORE', accountRole: 'household-cash', note: NOTE, notes: NOTE };
  const pc = cls(personal);
  ok(pc.categoryId === 'dale-guilt-free' && pc.includeReason === 'owner-evidence-dale',
    'contrast: the same note on an unlinked Shopping row is still Dale (owner attribution unchanged)', why(pc));
}

console.log('\n=== B. cadence restarts at the last purchase (Dale 2026-11-12) ===');
const debts = [{ id: 'triangle', label: 'Triangle', secured: false, structure: 'Revolving',
  balance: 100, rate: 21.99, payment: 25, pending: 0 }];
function periodAt(plan, start, packet) {
  const opts = { targetBuffer: 500, debts };
  if (packet) opts.currentPeriodActuals = packet;
  const r = F.recommend(plan, start, opts);
  return ((r.defaultView && r.defaultView.calendarPeriods) || []).find(p => p && p.start === start) || null;
}
const petsRow = p => ((p && p.householdBudget) || []).find(r => r && r.id === 'pets') || null;
const packetOf = txs => ({ transactions: txs });
// A packet whose 120-day lookup affirmatively completed and found only
// what its rows show: the envelope the real fetch stamps on a finished
// read. Scenarios that assert the anchor fallback or a non-restart rule
// run under this envelope — a packet with NO envelope is missing
// evidence, and the gate leaves its phase unavailable (section F).
const COMPLETE_WINDOW = { complete: true, hasMore: false, truncated: false };
const packetComplete = txs => ({ transactions: txs, dogFoodLookupWindow: COMPLETE_WINDOW });
const buyOn = (date, extra) => Object.assign({}, crudo, { date }, extra || {});
function expectSchedule(label, packet, onStarts, offStarts) {
  for (const s of onStarts) {
    const row = petsRow(periodAt(livePlan, s, packet));
    ok(row && near(row.planned, 100) && near(row.hold, 100), `${label}: ${s} holds Dog food`, row && String(row.planned));
  }
  for (const s of offStarts) {
    const row = petsRow(periodAt(livePlan, s, packet));
    ok(!row || (near(row.planned, 0) && near(row.hold, 0)), `${label}: ${s} has no Dog food hold`);
  }
}
{
  ok(!('paydayCadenceSkips' in livePets), 'pets.paydayCadenceSkips is gone (the restart rule replaces the one-time skip)');
  ok(livePets.paydayCadenceAnchor === '2026-08-28', 'anchor is unchanged (2026-08-28) — fallback only');

  // Fallback: no purchase evidence at all -> the anchor phase governs,
  // and Nov 20 holds again now that the one-time skip is removed.
  expectSchedule('anchor fallback (no packet)', null,
    ['2026-08-28', '2026-09-25', '2026-10-23', '2026-11-20', '2026-12-18'],
    ['2026-09-11', '2026-10-09', '2026-11-06', '2026-12-04']);

  // Dale's accepted schedule: the posted Nov 9, 2026 purchase (Nov 6
  // period, OFF under the anchor) restarts the count from its own period.
  expectSchedule('Nov 9 purchase restarts', packetOf([buyOn('2026-11-09')]),
    ['2026-11-06', '2026-12-04', '2027-01-01'],
    ['2026-11-20', '2026-12-18', '2026-10-23']);

  // A purchase in an ON period (Oct 26, in the Oct 23 period) restarts
  // onto the same alternation as the anchor.
  expectSchedule('purchase in an ON period', packetOf([buyOn('2026-10-26')]),
    ['2026-10-23', '2026-11-20', '2026-12-18'],
    ['2026-11-06', '2026-12-04']);

  // Two purchases in a row: the second (Nov 25, Nov 20 period) restarts
  // again and governs.
  expectSchedule('two purchases in a row', packetOf([buyOn('2026-11-09'), buyOn('2026-11-25', { id: 9002 })]),
    ['2026-11-20', '2026-12-18'],
    ['2026-11-06', '2026-12-04', '2027-01-01']);

  // The latest purchase wins when earlier ones disagree.
  expectSchedule('latest purchase wins', packetOf([buyOn('2026-10-26'), buyOn('2026-11-09', { id: 9003 })]),
    ['2026-12-04'], ['2026-11-20', '2026-12-18']);

  // Grok Bot conditions (2026-11-12): a pending purchase does not restart
  // the count until it posts; a refund/credit never counts.
  expectSchedule('pending purchase ignored', packetComplete([buyOn('2026-11-09', { pending: true })]),
    ['2026-11-20', '2026-12-18'], ['2026-11-06', '2026-12-04']);
  // Atlas blocker, PR #1127: a pending row whose forecast settlement
  // treatment presumes it settled is still a pending row — the observer
  // emits pending and pendingTreatment separately, and only an actually
  // posted row restarts the count.
  expectSchedule('presumed-settled pending ignored', packetComplete([buyOn('2026-11-09', { pending: true, pendingTreatment: 'presumed-settled-for-current-forecast' })]),
    ['2026-11-20', '2026-12-18'], ['2026-11-06', '2026-12-04']);
  expectSchedule('confirmed-settled pending ignored', packetComplete([buyOn('2026-11-09', { pending: true, pendingTreatment: 'confirmed-settled' })]),
    ['2026-11-20', '2026-12-18'], ['2026-11-06', '2026-12-04']);
  expectSchedule('refund ignored', packetComplete([buyOn('2026-11-09', { amount: -SYN_AMT })]),
    ['2026-11-20', '2026-12-18'], ['2026-11-06', '2026-12-04']);

  // The name fallback is part of the ledger rule: a posted unlinked
  // SURREY MEAT purchase restarts the count the same way.
  const smBuy = { date: '2026-11-09', amount: SYN_AMT, pending: false, currency: 'cad',
    categoryLabel: 'Pets', displayedPayee: 'SURREY MEAT PKR _F',
    originalMerchant: 'SURREY MEAT PKR _F', accountRole: 'household-cash' };
  expectSchedule('SURREY MEAT purchase restarts', packetOf([smBuy]),
    ['2026-12-04'], ['2026-11-20', '2026-12-18']);

  // A linked row Lunch Money filed as Groceries is not a dog food
  // purchase (H1) and does not restart the count.
  expectSchedule('linked Groceries row ignored', packetComplete([buyOn('2026-11-09', { categoryLabel: 'Groceries', categoryId: '42' })]),
    ['2026-11-20', '2026-12-18'], ['2026-11-06', '2026-12-04']);

  // Month-figure decision unchanged: the calendar-month owner target is
  // the standing rate, untouched by the cadence restart.
  const bd = F.budgetBreakdown(livePlan, { asOf: '2026-11-20',
    periods: { ytd: { label: 'YTD', months: 10, spending: [] } } }, {});
  const pets = (bd.categories || []).find(c => c.id === 'pets');
  ok(pets && near(pets.target, 100), 'monthly Dog food target stays $100 (ownerTargetMonthly unchanged)', pets && String(pets.target));
}

console.log('\n=== C. durable latest-purchase evidence (lead ruling 6838804386, option (a)) ===');
{
  // Blocker 1 (Atlas, PR #1127): the restart phase must not depend on
  // the purchase still being inside the packet's own observation
  // window. The observer looks the most recent qualifying purchase up
  // over the incumbent 120-day cap (the same Lunch Money GET with a
  // wider start; GET only) and the packet retains it as
  // dogFoodLatestPurchase evidence. Forecast reads it from there; no
  // qualifying purchase within 120 days keeps the anchor fallback.
  const accountMap = { schema: 'atlas-provider-account-map/v1', mappings: [{ providerAccountId: '1001',
    canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' }] };
  const groceryRow = { date: '2026-11-25', amount: 82.10, pending: false,
    savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Groceries',
    categoryId: '42', payee: 'GROCERY STORE', originalName: 'GROCERY STORE',
    providerAccountId: '1001', providerTransactionId: '990101' };
  const lookupBuy = (date, extra) => Object.assign({ date, amount: SYN_AMT, pending: false,
    savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Pet supplies',
    categoryId: CATEGORY_ID, recurringId: RECURRING_ID, payee: 'Surrey Meat Pkr',
    originalName: 'CRUDO BY SURREY _F', providerAccountId: '1001',
    providerTransactionId: String(TX_ID) }, extra || {});
  const observedPacket = (collapsed, lookup) => O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-11-27T18:00:00.000Z',
    transactionWindow: { startDate: '2026-11-14', endDate: '2026-11-27', complete: true },
    pendingCoverage: { complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false },
    collapsedTransactions: collapsed,
    ...(lookup ? { dogFoodLookupTransactions: lookup } : {}),
    // These scenarios model a lookup that ran to completion (the real
    // fetch always records its window); section D covers the
    // incomplete and malformed reads.
    dogFoodLookupWindow: COMPLETE_WINDOW,
    representedEventCandidates: [],
  }, { asOf: '2026-11-27', plan: livePlan, accountMap });

  // C1: the Nov 9 purchase is outside the packet window (start Nov 14)
  // and absent from its transactions, yet the retained evidence carries
  // it and Forecast phases from the purchase, not the anchor.
  const aged = observedPacket([groceryRow], [lookupBuy('2026-11-09')]);
  ok(aged && !(aged.transactions || []).some(r => r && r.date === '2026-11-09'),
    'aged purchase is not folded into packet transactions');
  ok(aged && aged.dogFoodLatestPurchase && aged.dogFoodLatestPurchase.date === '2026-11-09',
    'packet retains the aged-out latest purchase as evidence',
    aged && JSON.stringify(aged.dogFoodLatestPurchase));
  expectSchedule('aged-out purchase still restarts', aged,
    ['2026-11-06', '2026-12-04', '2027-01-01'],
    ['2026-11-20', '2026-12-18', '2026-10-23']);

  // C2: no qualifying purchase within the 120-day cap -> no retained
  // evidence, and the anchor fallback governs. (Cap bound: asOf
  // 2026-11-27 minus 120 days is 2026-07-30 — a Jul 31 purchase is
  // inside the cap, a Jul 1 purchase is not.)
  const tooOld = observedPacket([groceryRow], [lookupBuy('2026-07-01')]);
  ok(tooOld && !tooOld.dogFoodLatestPurchase, 'purchase older than the 120-day cap is not retained');
  expectSchedule('no purchase within 120 days falls back', tooOld,
    ['2026-11-20', '2026-12-18'], ['2026-11-06', '2026-12-04']);
  const insideCap = observedPacket([groceryRow], [lookupBuy('2026-07-31')]);
  ok(insideCap && insideCap.dogFoodLatestPurchase
      && insideCap.dogFoodLatestPurchase.date === '2026-07-31',
    'purchase inside the 120-day cap is retained');

  // C3: pending and refund lookup rows never qualify (blocker 2 gates).
  const pendingLookup = observedPacket([groceryRow],
    [lookupBuy('2026-11-09', { pending: true, savingsPostingEvidence: 'pending' })]);
  ok(pendingLookup && !pendingLookup.dogFoodLatestPurchase, 'pending lookup row is not retained');
  const refundLookup = observedPacket([groceryRow],
    [lookupBuy('2026-11-09', { amount: -SYN_AMT })]);
  ok(refundLookup && !refundLookup.dogFoodLatestPurchase, 'refund lookup row is not retained');

  // C4: Forecast reads the retained evidence on its own, and a newer
  // purchase inside the packet still wins over an older retained date.
  expectSchedule('retained evidence alone restarts',
    { transactions: [], dogFoodLatestPurchase: { date: '2026-11-09' } },
    ['2026-11-06', '2026-12-04'], ['2026-11-20', '2026-12-18']);
  expectSchedule('newer in-packet purchase beats retained date',
    { transactions: [buyOn('2026-11-25', { id: 9002 })], dogFoodLatestPurchase: { date: '2026-11-09' } },
    ['2026-11-20', '2026-12-18'], ['2026-11-06', '2026-12-04', '2027-01-01']);

  // C5: when the latest purchase is already in the packet, the observer
  // stamps nothing extra — the packet is unchanged.
  const inPacketRow = { date: '2026-11-09', amount: SYN_AMT, pending: false,
    savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Pet supplies',
    categoryId: CATEGORY_ID, recurringId: RECURRING_ID, payee: 'Surrey Meat Pkr',
    originalName: 'CRUDO BY SURREY _F', providerAccountId: '1001',
    providerTransactionId: String(TX_ID) };
  const alreadyIn = observedPacket([inPacketRow], [lookupBuy('2026-11-09')]);
  ok(alreadyIn && !alreadyIn.dogFoodLatestPurchase,
    'no retained-evidence field when the purchase is already in the packet');
  expectSchedule('in-packet purchase still governs', alreadyIn,
    ['2026-11-06', '2026-12-04'], ['2026-11-20', '2026-12-18']);

  // C6: payload normalization carries the lookup collection through in
  // normalized form (the fetch itself is the same GET with the 120-day
  // start; see fetchLunchMoneyLive's dogFoodLookup option).
  const normalized = O.normalizeLunchMoneyPayload({
    fetchedAt: '2026-11-27T18:00:00.000Z',
    accounts: [], transactions: [],
    categories: [{ id: Number(CATEGORY_ID), name: 'Pet supplies' }],
    dogFoodLookupTransactions: [{ id: TX_ID, date: '2026-11-09', amount: String(SYN_AMT),
      currency: 'cad', payee: 'Surrey Meat Pkr', original_name: 'CRUDO BY SURREY _F',
      category_id: Number(CATEGORY_ID), recurring_id: Number(RECURRING_ID),
      account_id: 1001, is_pending: false }],
  }, '2026-11-27T18:00:00.000Z');
  const lookupRows = (normalized && normalized.dogFoodLookupTransactions) || [];
  ok(lookupRows.length === 1 && lookupRows[0].recurringId === RECURRING_ID
      && lookupRows[0].pending === false && lookupRows[0].date === '2026-11-09',
    'normalizeLunchMoneyPayload carries dogFoodLookupTransactions in normalized form',
    JSON.stringify(lookupRows.map(r => ({ d: r.date, rec: r.recurringId, p: r.pending }))));
}

console.log('\n=== D. lookup completeness through the real fetch path (Atlas blocker on 48293db8) ===');
{
  // Atlas findings 6841610384: the 120-day lookup discarded the paged
  // reader's completeness evidence, so an incomplete or malformed read
  // could silently publish the anchor phase. Lead disposition
  // (2026-11-12): carry complete/hasMore/truncated into the packet; only
  // a COMPLETE lookup may establish "no qualifying purchase" (anchor
  // fallback) or name the latest purchase; an incomplete or malformed
  // lookup leaves the phase UNAVAILABLE (Grok Bot condition
  // 1794525655.686989) unless the normal complete window already holds
  // a qualifying posted purchase, which still wins. These scenarios run
  // the real fetchLunchMoneyLive against a loopback stub provider —
  // no real provider calls, credentials or household values.
  const http = require('http');
  const accountMapD = { schema: 'atlas-provider-account-map/v1', mappings: [{ providerAccountId: '1001',
    canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' }] };
  const groceryCollapsedD = { date: '2026-11-25', amount: 82.10, pending: false,
    savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Groceries',
    categoryId: '42', payee: 'GROCERY STORE', originalName: 'GROCERY STORE',
    providerAccountId: '1001', providerTransactionId: '990101' };
  const LM_BUY = { id: TX_ID, date: '2026-11-09', amount: String(SYN_AMT), currency: 'cad',
    payee: 'Surrey Meat Pkr', original_name: 'CRUDO BY SURREY _F',
    category_id: Number(CATEGORY_ID), recurring_id: Number(RECURRING_ID),
    account_id: 1001, is_pending: false, status: 'cleared' };
  const LM_GROCERY = { id: 990101, date: '2026-11-25', amount: '82.10', currency: 'cad',
    payee: 'GROCERY STORE', original_name: 'GROCERY STORE', category_id: 42,
    account_id: 1001, is_pending: false, status: 'cleared' };

  function lmStub(lookupHandler) {
    return new Promise(resolve => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const send = obj => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (url.pathname === '/me') return send({ account_id: 777 });
        if (url.pathname === '/plaid_accounts') return send({ plaid_accounts: [] });
        if (url.pathname === '/manual_accounts') return send({ manual_accounts: [{ id: 1001, name: 'Chequing', type: 'depository', subtype: 'checking', currency: 'cad', balance: '1000.00' }] });
        if (url.pathname === '/categories') return send({ categories: [{ id: Number(CATEGORY_ID), name: 'Pet supplies', is_income: false }, { id: 42, name: 'Groceries', is_income: false }] });
        if (url.pathname === '/tags') return send({ tags: [] });
        if (url.pathname === '/transactions') {
          if (url.searchParams.get('is_pending') === 'true') return send({ transactions: [], has_more: false });
          if (url.searchParams.get('start_date') === '2026-07-30') return send(lookupHandler(Number(url.searchParams.get('offset') || 0)));
          return send({ transactions: [], has_more: false });
        }
        res.writeHead(404); res.end('{}');
      });
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }
  async function fetchViaStub(lookupHandler) {
    const server = await lmStub(lookupHandler);
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const payload = await O.fetchLunchMoneyLive('stub-token', '2026-11-27T18:00:00.000Z', 45,
        { env: { ATLAS_LUNCHMONEY_API_BASE: base }, dogFoodLookup: true });
      return { payload, normalized: O.normalizeLunchMoneyPayload(payload, payload.fetchedAt) };
    } finally { server.close(); }
  }
  const packetFromFetch = (normalized, collapsed) => O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-11-27T18:00:00.000Z',
    transactionWindow: { startDate: '2026-11-14', endDate: '2026-11-27', complete: true },
    pendingCoverage: { complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false },
    collapsedTransactions: collapsed || [groceryCollapsedD],
    dogFoodLookupTransactions: (normalized && normalized.dogFoodLookupTransactions) || [],
    ...(normalized && normalized.dogFoodLookupWindow ? { dogFoodLookupWindow: normalized.dogFoodLookupWindow } : {}),
    representedEventCandidates: [],
  }, { asOf: '2026-11-27', plan: livePlan, accountMap: accountMapD });
  function expectUnavailable(label, packet) {
    for (const s of ['2026-11-20', '2026-12-04', '2026-12-18', '2027-01-01']) {
      const row = petsRow(periodAt(livePlan, s, packet));
      ok(!row || (near(row.planned, 0) && near(row.hold, 0)),
        `${label}: ${s} publishes no Dog food hold (phase unavailable)`);
    }
  }

  (async () => {
    // D1: lookup page claims more (has_more:true) but is empty — the
    // read is truncated, not a successful empty read.
    const d1 = await fetchViaStub(() => ({ transactions: [], has_more: true }));
    ok(d1.payload.dogFoodLookupWindow && d1.payload.dogFoodLookupWindow.complete === false
        && d1.payload.dogFoodLookupWindow.hasMore === true && d1.payload.dogFoodLookupWindow.truncated === true,
      'D1 fetch carries lookup completeness (has_more empty page = incomplete)',
      JSON.stringify(d1.payload.dogFoodLookupWindow));
    const p1 = packetFromFetch(d1.normalized);
    ok(p1 && !p1.dogFoodLatestPurchase, 'D1 no retained purchase from an incomplete lookup');
    ok(p1 && p1.dogFoodLookupWindow && p1.dogFoodLookupWindow.complete === false,
      'D1 packet carries the incomplete lookup window');
    expectUnavailable('D1 incomplete empty lookup', p1);

    // D2: page-limit exhaustion — every page claims more; the reader
    // stops at its page cap with the read still incomplete.
    const d2 = await fetchViaStub(() => ({ transactions: [LM_GROCERY], has_more: true }));
    ok(d2.payload.dogFoodLookupWindow && d2.payload.dogFoodLookupWindow.complete === false
        && d2.payload.dogFoodLookupWindow.truncated === true,
      'D2 page-limit exhaustion is incomplete', JSON.stringify(d2.payload.dogFoodLookupWindow));
    expectUnavailable('D2 page-limit exhaustion', packetFromFetch(d2.normalized));

    // D3: malformed transactions payload (not an array) — the reader
    // fails closed; the phase is unavailable, not the anchor.
    const d3 = await fetchViaStub(() => ({ transactions: 'malformed', has_more: false }));
    ok(d3.payload.dogFoodLookupWindow && d3.payload.dogFoodLookupWindow.complete === false
        && d3.payload.dogFoodLookupWindow.truncated === true,
      'D3 malformed lookup page is incomplete', JSON.stringify(d3.payload.dogFoodLookupWindow));
    expectUnavailable('D3 malformed lookup', packetFromFetch(d3.normalized));

    // D4: a partial page holding an older qualifying purchase, then an
    // empty page still claiming more — the partial candidate is NOT
    // authoritative: no retained date, phase unavailable.
    const d4 = await fetchViaStub(offset => offset === 0
      ? { transactions: [LM_BUY], has_more: true }
      : { transactions: [], has_more: true });
    const p4 = packetFromFetch(d4.normalized);
    ok(p4 && !p4.dogFoodLatestPurchase, 'D4 partial-page purchase is not retained as latest');
    expectUnavailable('D4 partial page with older purchase', p4);

    // D5: a complete lookup that finds nothing — the anchor fallback is
    // established by complete evidence and governs.
    const d5 = await fetchViaStub(() => ({ transactions: [], has_more: false }));
    ok(d5.payload.dogFoodLookupWindow && d5.payload.dogFoodLookupWindow.complete === true,
      'D5 complete empty lookup carries complete:true');
    const p5 = packetFromFetch(d5.normalized);
    ok(p5 && !p5.dogFoodLatestPurchase && p5.dogFoodLookupWindow && p5.dogFoodLookupWindow.complete === true,
      'D5 packet: complete lookup, no retained purchase');
    expectSchedule('D5 complete empty lookup falls back', p5,
      ['2026-11-20', '2026-12-18'], ['2026-12-04', '2027-01-01']);

    // D6: a complete lookup holding the Nov 9 purchase — retained
    // through the real fetch path; the purchase phase governs.
    const d6 = await fetchViaStub(() => ({ transactions: [LM_BUY], has_more: false }));
    const p6 = packetFromFetch(d6.normalized);
    ok(p6 && p6.dogFoodLatestPurchase && p6.dogFoodLatestPurchase.date === '2026-11-09',
      'D6 complete lookup retains the Nov 9 purchase', JSON.stringify(p6 && p6.dogFoodLatestPurchase));
    expectSchedule('D6 complete lookup purchase restarts', p6,
      ['2026-11-06', '2026-12-04'], ['2026-11-20', '2026-12-18']);

    // D7: incomplete lookup, but the normal complete window already
    // holds the qualifying posted purchase — it still wins.
    const inPacketBuyD = { date: '2026-11-09', amount: SYN_AMT, pending: false,
      savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Pet supplies',
      categoryId: CATEGORY_ID, recurringId: RECURRING_ID, payee: 'Surrey Meat Pkr',
      originalName: 'CRUDO BY SURREY _F', providerAccountId: '1001',
      providerTransactionId: String(TX_ID) };
    const d7 = await fetchViaStub(() => ({ transactions: [], has_more: true }));
    const p7 = packetFromFetch(d7.normalized, [inPacketBuyD]);
    expectSchedule('D7 in-packet purchase beats incomplete lookup', p7,
      ['2026-11-06', '2026-12-04'], ['2026-11-20', '2026-12-18']);

    // D8: Forecast-side enforcement — a retained stamp paired with an
    // incomplete lookup window is not honoured, and the anchor does
    // not take its place.
    expectUnavailable('D8 stamp with incomplete window ignored',
      { transactions: [], dogFoodLatestPurchase: { date: '2026-11-09' },
        dogFoodLookupWindow: { complete: false, hasMore: true, truncated: true } });

    // D9: the same stamp paired with a complete window is honoured.
    expectSchedule('D9 stamp with complete window honoured',
      { transactions: [], dogFoodLatestPurchase: { date: '2026-11-09' },
        dogFoodLookupWindow: { complete: true, hasMore: false, truncated: false } },
      ['2026-11-06', '2026-12-04'], ['2026-11-20', '2026-12-18']);

    console.log('\n=== E. single gate: unavailable evidence reaches the published hold (Atlas blockers on 0225944b) ===');
    // Blocker 1 (pre-review 6843723957 + Atlas 6843815092 finding 1):
    // when the packet sanitizer rejects the packet, the lookup evidence
    // was deleted, so Forecast read "no lookup in play" and the anchor
    // governed on the weakest evidence. The rejection must itself stamp
    // the evidence incomplete, and the published hold must go unknown.
    // Blocker 2 (Atlas finding 2): the normal incomplete-lookup path
    // returned a null ON phase that every consumer read as an ordinary
    // OFF cycle — the Dog food row vanished and budgetHold stayed a
    // numeric estimate, lower than the identical complete-empty control
    // on an anchor-ON period. An unknown phase is an unknown
    // obligation: budgetHold null, stamped unavailable, the pets row
    // listed with unknown amounts — never $0 omission, never OFF.
    const packetWithWindow = (collapsed, window) => O.sanitizedCurrentPeriodActuals({
      fetchedAt: '2026-11-27T18:00:00.000Z',
      transactionWindow: { startDate: '2026-11-14', endDate: '2026-11-27', complete: true },
      pendingCoverage: { complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false },
      collapsedTransactions: collapsed,
      dogFoodLookupTransactions: [],
      dogFoodLookupWindow: window,
      representedEventCandidates: [],
    }, { asOf: '2026-11-27', plan: livePlan, accountMap: accountMapD });
    function expectHoldUnavailable(label, packet) {
      for (const s of ['2026-11-20', '2026-12-04']) {
        const p = periodAt(livePlan, s, packet);
        const row = petsRow(p);
        ok(p && p.budgetHold === null && p.budgetHoldTrust === 'unavailable',
          `${label}: ${s} budgetHold is unknown and stamped unavailable`,
          p && `hold=${p.budgetHold} trust=${p.budgetHoldTrust}`);
        ok(row && row.planned === null && row.hold === null
            && row.withheldReason === 'dog-food-evidence-unavailable',
          `${label}: ${s} Dog food row is listed with unknown amounts, not omitted as OFF`,
          row && JSON.stringify({ planned: row.planned, hold: row.hold, w: row.withheldReason }));
      }
      const on = periodAt(livePlan, '2026-11-20', packet);
      ok(on && on.balanceAfterDeductions === null,
        `${label}: Balance After Deductions is unknown on the anchor-ON period`,
        on && String(on.balanceAfterDeductions));
    }

    // E1: sanitizer rejection (a merchant string carrying "Bearer …"
    // trips the packet sanitizer) — the packet comes back incomplete
    // with its evidence stamped incomplete, not erased.
    const rejected = packetWithWindow(
      [Object.assign({}, groceryCollapsedD, { payee: 'Bearer ABC123', originalName: 'Bearer ABC123' })],
      { complete: false, hasMore: true, truncated: true });
    ok(rejected && rejected.transactionCoverage === 'incomplete' && rejected.transactions.length === 0,
      'E1 sanitizer rejection still fails the packet closed');
    ok(rejected && rejected.dogFoodLookupWindow && rejected.dogFoodLookupWindow.complete === false,
      'E1 rejection stamps the lookup window incomplete instead of erasing it',
      JSON.stringify(rejected && rejected.dogFoodLookupWindow));
    ok(rejected && !rejected.dogFoodLatestPurchase,
      'E1 no retained purchase survives a sanitizer rejection');
    expectHoldUnavailable('E1 sanitizer-rejected packet', rejected);

    // E2: the normal incomplete-lookup path, contrasted with the
    // identical complete-empty control on the same fixture.
    const incompletePkt = packetWithWindow([groceryCollapsedD],
      { complete: false, hasMore: true, truncated: true });
    expectHoldUnavailable('E2 incomplete lookup', incompletePkt);
    const controlPkt = packetWithWindow([groceryCollapsedD],
      { complete: true, hasMore: false, truncated: false });
    const controlOn = periodAt(livePlan, '2026-11-20', controlPkt);
    const controlRow = petsRow(controlOn);
    ok(controlRow && near(controlRow.planned, 100) && near(controlRow.hold, 100)
        && controlOn.budgetHold != null && controlOn.budgetHoldTrust !== 'unavailable',
      'E2 complete-empty control keeps the anchor phase and a numeric hold',
      controlOn && `hold=${controlOn.budgetHold} trust=${controlOn.budgetHoldTrust}`);
    const controlOff = periodAt(livePlan, '2026-12-04', controlPkt);
    ok(!petsRow(controlOff) && controlOff.budgetHold != null,
      'E2 complete-empty control: the anchor-OFF period still omits Dog food with a numeric hold');

    // E3: purchase-found and pending rules still govern at the
    // publication level when a lookup window is present.
    const purchasePkt = { transactions: [], dogFoodLatestPurchase: { date: '2026-11-09' },
      dogFoodLookupWindow: { complete: true, hasMore: false, truncated: false } };
    const purchasePeriod = periodAt(livePlan, '2026-12-04', purchasePkt);
    const purchaseRow = petsRow(purchasePeriod);
    ok(purchaseRow && near(purchaseRow.planned, 100) && purchasePeriod.budgetHold != null
        && purchasePeriod.budgetHoldTrust !== 'unavailable',
      'E3 complete lookup with a purchase publishes the purchase phase and a numeric hold');
    const pendingPkt = { transactions: [buyOn('2026-11-09', { pending: true })],
      dogFoodLookupWindow: { complete: true, hasMore: false, truncated: false } };
    const pendingPeriod = periodAt(livePlan, '2026-11-20', pendingPkt);
    const pendingRow = petsRow(pendingPeriod);
    ok(pendingRow && near(pendingRow.planned, 100) && pendingPeriod.budgetHold != null,
      'E3 a pending purchase never restarts: the anchor phase governs the complete read');

    console.log('\n=== F. missing/malformed evidence is unavailable; unknown reaches the span views (Atlas blockers on ed754ca8) ===');
    // Blocker 1 (Atlas 6863051455 finding 1): the gate read an absent
    // or non-object envelope as "not incomplete" and returned
    // complete-empty, and returned complete-empty when the transactions
    // array was missing even under an incomplete flag. Missing or
    // malformed evidence proves no completed empty lookup: only an
    // affirmatively complete, well-formed envelope over a delivered
    // transactions array establishes complete-empty.
    expectHoldUnavailable('F1a packet with no envelope', { transactions: [] });
    expectHoldUnavailable('F1b string-valued envelope',
      { transactions: [], dogFoodLookupWindow: 'malformed' });
    expectHoldUnavailable('F1c incomplete envelope, transactions array missing',
      { dogFoodLookupWindow: { complete: false, hasMore: true, truncated: true } });
    expectHoldUnavailable('F1d malformed purchase record under a complete envelope',
      { transactions: [], dogFoodLatestPurchase: { date: 'not-a-date' },
        dogFoodLookupWindow: COMPLETE_WINDOW });
    expectHoldUnavailable('F1e malformed envelope field type',
      { transactions: [], dogFoodLookupWindow: { complete: true, hasMore: 'no', truncated: false } });
    expectHoldUnavailable('F1f string purchase record under a complete envelope',
      { transactions: [], dogFoodLatestPurchase: '2026-11-09',
        dogFoodLookupWindow: COMPLETE_WINDOW });
    // The packet-less case is the one absence that is not missing
    // evidence: no lookup is in play, so the anchor governs (section B).
    const noPacketPeriod = periodAt(livePlan, '2026-11-20', null);
    const noPacketRow = petsRow(noPacketPeriod);
    ok(noPacketRow && near(noPacketRow.planned, 100) && noPacketPeriod.budgetHold != null,
      'F1g no packet at all keeps the anchor (no lookup in play)');

    // Blocker 2 (Atlas 6863051455 finding 2): the span views omitted a
    // null-phase Dog food row and totalled the surviving rows, so the
    // next-period view published a numeric leftover on an unknown
    // obligation. The row now publishes unknown in the span, the span
    // total is unknown, and the balances after the household budget go
    // unknown with it.
    const npvOf = packet => F.recommend(livePlan, '2026-11-20',
      { targetBuffer: 500, debts, currentPeriodActuals: packet }).nextPeriodView;
    const npv = npvOf({ transactions: [],
      dogFoodLookupWindow: { complete: false, hasMore: true, truncated: true } });
    const npvRow = ((npv && npv.householdBudget) || []).find(r => r && r.id === 'pets') || null;
    ok(npv && npv.periodStart === '2026-12-04' && npvRow && npvRow.amount === null
        && npvRow.withheldReason === 'dog-food-evidence-unavailable',
      'F2 next-period view lists the Dog food row as unknown, not omitted',
      npvRow && JSON.stringify(npvRow));
    ok(npv && npv.afterHouseholdBudget === null && npv.afterDebtRepayment === null
        && npv.afterBigPurchases === null,
      'F2 next-period balances after the household budget are unknown, not numeric',
      npv && `${npv.afterHouseholdBudget}/${npv.afterDebtRepayment}/${npv.afterBigPurchases}`);
    const npvControl = npvOf({ transactions: [], dogFoodLookupWindow: COMPLETE_WINDOW });
    const npvControlRow = ((npvControl && npvControl.householdBudget) || [])
      .find(r => r && r.id === 'pets') || null;
    ok(npvControl && typeof npvControl.afterHouseholdBudget === 'number'
        && (!npvControlRow || typeof npvControlRow.amount === 'number'),
      'F2 complete-empty control: next-period leftover stays numeric, no unknown row');
  })().then(() => {
    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
  }, err => {
    console.log('  FAIL  section D threw — ' + (err && err.message));
    console.log(`\n${failures + 1} CHECK(S) FAILED`);
    process.exit(1);
  });
}
