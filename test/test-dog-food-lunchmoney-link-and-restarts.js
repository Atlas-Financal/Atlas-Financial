'use strict';
/* Dog food spending follows the Lunch Money ledger, while its payday
 * cadence is owner-maintained in data.json (Dale 2026-11-11 for spending;
 * lead replacement decision on PR #1127, 2026-11-13, for cadence).
 *
 * A. The Lunch Money recurring-item link (pets.dogFoodLunchMoneyRecurringIds)
 *    is the primary signal; the Lunch Money category is only a second
 *    condition, never enough alone. The original-merchant name match
 *    (SURREY MEAT only) stays only as a fallback for unlinked rows; the
 *    link takes priority. A second merchant spelling (CRUDO BY SURREY)
 *    was dropped on Grok Bot's ruling (2026-11-11, rule 17): no new name
 *    matching, so an unlinked CRUDO BY SURREY row is never Dog food by name.
 * B. pets.paydayCadenceRestarts names ON pay-period starts. The latest
 *    restart at or before a period governs that period and alternates
 *    forward from it; earlier periods keep the previous phase. The live
 *    restart is 2026-11-06, the period containing Dale's 2026-11-09
 *    purchase: Nov 20 is OFF, Dec 4 ON, Dec 18 OFF, and Jan 1 ON.
 *
 * Independent of the helper under change (L-002): the expected ON/OFF
 * schedule is walked here from phase origins in 14-day steps, and the
 * live schedule is reconciled against a counterfactual plan with no
 * restarts. Amounts on transactions are synthetic.
 *
 * `node test/test-dog-food-lunchmoney-link-and-restarts.js`
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

console.log('\n=== B. owner-maintained cadence restarts ===');
const debts = [{ id: 'triangle', label: 'Triangle', secured: false, structure: 'Revolving',
  balance: 100, rate: 21.99, payment: 25, pending: 0 }];
function periodAt(plan, start) {
  const r = F.recommend(plan, start, { targetBuffer: 500, debts });
  return ((r.defaultView && r.defaultView.calendarPeriods) || []).find(p => p && p.start === start) || null;
}
const petsRow = p => ((p && p.householdBudget) || []).find(r => r && r.id === 'pets') || null;
function planWithRestarts(restarts) {
  const plan = clone(livePlan);
  const pets = plan.budget.categories.find(c => c.id === 'pets');
  delete pets.paydayCadenceSkips;
  if (restarts === null) delete pets.paydayCadenceRestarts;
  else pets.paydayCadenceRestarts = restarts.map(periodStart => ({
    periodStart, reason: 'synthetic restart proof', source: 'test fixture',
  }));
  return plan;
}
function diffDays(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
function independentCycleStart(payrollAnchor, iso) {
  let start = payrollAnchor;
  while (addDays(start, 14) <= iso) start = addDays(start, 14);
  while (start > iso) start = addDays(start, -14);
  return start;
}
// Independent phase walk: the anchor and every restart are ON origins.
// The latest origin at or before a period governs it; if none is at or
// before it, the anchor phase is extrapolated as before.
function expectedRestartOn(start, restarts) {
  const origins = ['2026-08-28', ...restarts].filter(d => d <= start).sort();
  const origin = origins.length ? origins[origins.length - 1] : '2026-08-28';
  const steps = diffDays(origin, start) / 14;
  return Number.isInteger(steps) && steps % 2 === 0;
}
function okPeriod(plan, start, on, label) {
  const row = petsRow(periodAt(plan, start));
  if (on) {
    ok(row && near(row.planned, 100) && near(row.hold, 100),
      `${label}: ${start} holds Dog food`, row && String(row.planned));
  } else {
    ok(!row || (near(row.planned, 0) && near(row.hold, 0)),
      `${label}: ${start} has no Dog food hold`, row && String(row.planned));
  }
}
{
  ok(expectedRestartOn('2026-09-25', []) === true,
    'precondition: Sep 25 is ON under the anchor phase');
  ok(expectedRestartOn('2026-10-09', []) === false,
    'precondition: Oct 9 is OFF under the anchor phase');
  ok(expectedRestartOn('2026-10-23', ['2026-10-09']) === false,
    'precondition: with only an Oct 9 restart, Oct 23 would alternate OFF');
  ok(expectedRestartOn('2026-10-23', ['2026-10-09', '2026-10-23']) === true,
    'precondition: a second restart in the next period makes Oct 23 ON');

  const scenarios = [
    { label: 'restart in an ON period', restarts: ['2026-09-25'],
      starts: ['2026-09-11', '2026-09-25', '2026-10-09', '2026-10-23'] },
    { label: 'restart in an OFF period', restarts: ['2026-10-09'],
      starts: ['2026-09-25', '2026-10-09', '2026-10-23', '2026-11-06', '2026-11-20'] },
    { label: 'two restarts in a row', restarts: ['2026-10-09', '2026-10-23'],
      starts: ['2026-09-25', '2026-10-09', '2026-10-23', '2026-11-06', '2026-11-20', '2026-12-04'] },
  ];
  for (const scenario of scenarios) {
    const plan = planWithRestarts(scenario.restarts);
    for (const start of scenario.starts) {
      okPeriod(plan, start, expectedRestartOn(start, scenario.restarts), scenario.label);
    }
  }

  // Past periods keep the phase they already had: the two-restart plan
  // publishes byte-identical Pets rows before its first restart.
  const basePlan = planWithRestarts([]);
  const twoRestartPlan = planWithRestarts(['2026-10-09', '2026-10-23']);
  for (const start of ['2026-08-28', '2026-09-11', '2026-09-25']) {
    ok(JSON.stringify(petsRow(periodAt(twoRestartPlan, start)))
        === JSON.stringify(petsRow(periodAt(basePlan, start))),
      `past period ${start} is unchanged by later restarts`);
  }
}

console.log('\n=== B2. live restart replaces the one-time skip ===');
{
  const restarts = livePets.paydayCadenceRestarts || [];
  ok(restarts.length === 1 && restarts[0].periodStart === '2026-11-06'
      && restarts[0].reason && restarts[0].source
      && Object.keys(restarts[0]).every(k => ['periodStart', 'reason', 'source'].includes(k)),
    'pets.paydayCadenceRestarts holds one dated entry (date, reason, source; no amount)');
  ok(!Object.prototype.hasOwnProperty.call(livePets, 'paydayCadenceSkips'),
    'the replaced paydayCadenceSkips entry is gone from live pets');
  ok(livePets.paydayCadenceAnchor === '2026-08-28', 'anchor is unchanged (2026-08-28)');
  ok(independentCycleStart('2026-08-14', '2026-11-09') === '2026-11-06',
    'independent: Dale\'s 2026-11-09 purchase sits in the Nov 6 period');

  const expectedLive = new Map([
    ['2026-08-28', true], ['2026-09-11', false], ['2026-09-25', true],
    ['2026-10-09', false], ['2026-10-23', true], ['2026-11-06', true],
    ['2026-11-20', false], ['2026-12-04', true], ['2026-12-18', false],
    ['2027-01-01', true],
  ]);
  ok([...expectedLive].every(([start, on]) => expectedRestartOn(start, ['2026-11-06']) === on),
    'independent restart walk: Nov 20 OFF, Dec 4 ON, Dec 18 OFF, Jan 1 ON');
  for (const [start, on] of expectedLive) okPeriod(livePlan, start, on, 'live cadence');

  // Counterfactual: the same live plan with no restarts keeps the old
  // anchor phase, so Nov 6 and Dec 4 flip and Nov 20 flips back.
  const noRestart = planWithRestarts(null);
  okPeriod(noRestart, '2026-11-06', false, 'counterfactual without restarts');
  okPeriod(noRestart, '2026-11-20', true, 'counterfactual without restarts');
  okPeriod(noRestart, '2026-12-04', false, 'counterfactual without restarts');
  for (const start of ['2026-08-28', '2026-09-25', '2026-10-23']) {
    ok(JSON.stringify(petsRow(periodAt(livePlan, start)))
        === JSON.stringify(petsRow(periodAt(noRestart, start))),
      `live ${start} is identical with or without the restart (past unchanged)`);
  }
  const withRestart = periodAt(livePlan, '2026-11-20');
  const without = periodAt(noRestart, '2026-11-20');
  const rest = p => ((p && p.householdBudget) || []).filter(r => r && r.id !== 'pets')
    .map(r => `${r.id}:${roundCent(r.planned)}`).join('|');
  ok(rest(withRestart) === rest(without),
    'Nov 20 Household Budget equals the OFF-cycle composition: only Dog food drops');
  const total = p => roundCent(((p && p.householdBudget) || []).reduce((s, r) => s + (Number(r.planned) || 0), 0));
  ok(near(total(without) - total(withRestart), 100), 'the Nov 20 cycle total drops by exactly the Dog food hold');

  // Month-figure decision: the calendar-month owner target is the standing
  // rate and is not reduced by a dated cadence restart.
  const bd = F.budgetBreakdown(livePlan, { asOf: '2026-11-20',
    periods: { ytd: { label: 'YTD', months: 10, spending: [] } } }, {});
  const pets = (bd.categories || []).find(c => c.id === 'pets');
  ok(pets && near(pets.target, 100), 'monthly Dog food target stays $100 (ownerTargetMonthly unchanged)', pets && String(pets.target));
  ok(near(petsRow(without).monthly, 100), 'counterfactual row monthly is $100 as well');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
