'use strict';
/* Dog food follows the Lunch Money ledger, plus one owner one-time skip
 * (Dale 2026-11-11; CLAUDE.md rule 17).
 *
 * A. The Lunch Money recurring-item link (pets.dogFoodLunchMoneyRecurringIds)
 *    is the primary signal; the Lunch Money category is only a second
 *    condition, never enough alone. The original-merchant name match
 *    (SURREY MEAT only) stays only as a fallback for unlinked rows; the
 *    link takes priority. A second merchant spelling (CRUDO BY SURREY)
 *    was dropped on Grok Bot's ruling (2026-11-11, rule 17): no new name
 *    matching, so an unlinked CRUDO BY SURREY row is never Dog food by name.
 * B. pets.paydayCadenceSkips turns the Nov 20 - Dec 3, 2026 ON period OFF
 *    once. The cadence never shifts: Dec 4 stays OFF and Dec 18 stays ON.
 *
 * Independent of the helper under change (L-002): the expected ON/OFF
 * schedule is walked here from the anchor in 14-day steps, and the Nov 20
 * period is reconciled against a counterfactual plan without the skip.
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

console.log('\n=== B. one-time skip of the Nov 20 - Dec 3, 2026 hold ===');
const debts = [{ id: 'triangle', label: 'Triangle', secured: false, structure: 'Revolving',
  balance: 100, rate: 21.99, payment: 25, pending: 0 }];
function periodAt(plan, start) {
  const r = F.recommend(plan, start, { targetBuffer: 500, debts });
  return ((r.defaultView && r.defaultView.calendarPeriods) || []).find(p => p && p.start === start) || null;
}
const petsRow = p => ((p && p.householdBudget) || []).find(r => r && r.id === 'pets') || null;
{
  const skips = livePets.paydayCadenceSkips || [];
  ok(skips.length === 1 && skips[0].periodStart === '2026-11-20' && skips[0].reason && skips[0].source
      && Object.keys(skips[0]).every(k => ['periodStart', 'reason', 'source'].includes(k)),
    'pets.paydayCadenceSkips holds one dated entry (date, reason, source; no amount)');
  ok(livePets.paydayCadenceAnchor === '2026-08-28', 'anchor is unchanged (2026-08-28)');

  // Independent walk: 14-day steps from the 2026-08-28 ON anchor.
  const expected = new Map();
  let t = '2026-08-28';
  for (let i = 0; t <= '2026-12-18'; i++, t = addDays(t, 14)) {
    expected.set(t, i % 2 === 0 && t !== '2026-11-20');
  }
  const wantOn = ['2026-08-28', '2026-09-25', '2026-10-23', '2026-12-18'];
  const wantOff = ['2026-09-11', '2026-10-09', '2026-11-06', '2026-11-20', '2026-12-04'];
  ok(wantOn.every(d => expected.get(d) === true) && wantOff.every(d => expected.get(d) === false),
    'independent walk: Aug 28, Sep 25, Oct 23, Dec 18 ON; Sep 11, Oct 9, Nov 6, Nov 20 (skipped), Dec 4 OFF');
  for (const [start, on] of expected) {
    const row = petsRow(periodAt(livePlan, start));
    if (on) ok(row && near(row.planned, 100) && near(row.hold, 100), `${start} holds Dog food`, row && String(row.planned));
    else ok(!row || (near(row.planned, 0) && near(row.hold, 0)), `${start} has no Dog food hold`);
  }

  // Counterfactual: the same plan without the skip.
  const noSkip = clone(livePlan);
  delete noSkip.budget.categories.find(c => c.id === 'pets').paydayCadenceSkips;
  const withSkip = periodAt(livePlan, '2026-11-20');
  const without = periodAt(noSkip, '2026-11-20');
  ok(petsRow(without) && near(petsRow(without).planned, 100), 'without the skip Nov 20 would hold Dog food');
  const rest = p => ((p && p.householdBudget) || []).filter(r => r && r.id !== 'pets')
    .map(r => `${r.id}:${roundCent(r.planned)}`).join('|');
  ok(rest(withSkip) === rest(without),
    'Nov 20 Household Budget equals the OFF-cycle composition: only Dog food drops');
  const total = p => roundCent(((p && p.householdBudget) || []).reduce((s, r) => s + (Number(r.planned) || 0), 0));
  ok(near(total(without) - total(withSkip), 100), 'the Nov 20 cycle total drops by exactly the Dog food hold');
  for (const start of ['2026-12-04', '2026-12-18', '2026-11-06']) {
    ok(JSON.stringify(petsRow(periodAt(livePlan, start))) === JSON.stringify(petsRow(periodAt(noSkip, start))),
      `${start} is identical with or without the skip (no anchor shift)`);
  }
  const offStart = clone(livePlan);
  offStart.budget.categories.find(c => c.id === 'pets').paydayCadenceSkips = [{ periodStart: '2026-12-04', reason: 'x', source: 'x' }];
  ok(!petsRow(periodAt(offStart, '2026-12-04')) && petsRow(periodAt(offStart, '2026-11-20')),
    'a skip on an OFF period changes nothing and never turns a period ON');

  // Month-figure decision: the calendar-month owner target is the standing
  // rate and is not reduced by a one-time dated skip.
  const bd = F.budgetBreakdown(livePlan, { asOf: '2026-11-20',
    periods: { ytd: { label: 'YTD', months: 10, spending: [] } } }, {});
  const pets = (bd.categories || []).find(c => c.id === 'pets');
  ok(pets && near(pets.target, 100), 'monthly Dog food target stays $100 (ownerTargetMonthly unchanged)', pets && String(pets.target));
  ok(near(petsRow(without).monthly, 100), 'counterfactual row monthly is $100 as well');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
