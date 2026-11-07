'use strict';
// A4b (#820/#722): atomic routing and backing. Item spending enters the
// Forecast classification, the combined Savings backing, the funding and
// closing paths, with one cash-deduction owner per liability reference.
// Every account, amount, date and identity is invented; expectations are
// hand-derived from the adopted rules (acceptance #787 6622324225 checks 2
// and 3; blueprint 6620986508 sections 2, 3 and 5) and written as literals.
// Nothing here computes an expected value with the code under test.
//
// The path is production's: an invented raw Lunch Money payload goes
// through scripts/live-plan.js fromObservation (provider-observe), and the
// served plan and currentPeriodActuals reach Forecast.recommend and
// Forecast.savingsFundingPublication exactly as public/plan.js passes them.
const assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const F = require(path.join(ROOT, 'public/forecast'));
const Live = require(path.join(ROOT, 'scripts/live-plan'));
const clone = value => JSON.parse(JSON.stringify(value));

// ------------------------------------------------------------------ world
// Bills chequing-a (9001), spending chequing-b (9002), Savings (9003),
// purpose reserve savings-dont-touch (9005). As of 2026-10-14; payroll
// 1,400 biweekly from 2026-10-09. Category 106 "Trip" has no budget row.
const AS_OF = '2026-10-14';
const ACCOUNTS = [
  { id: 'chequing-a', providerId: 9001, role: 'household-cash', label: 'Invented bills', value: 2000 },
  { id: 'chequing-b', providerId: 9002, role: 'household-cash', label: 'Invented spending', value: 500 },
  { id: 'savings', providerId: 9003, role: 'household-reserve', label: 'Invented savings', value: 1000 },
  { id: 'savings-dont-touch', providerId: 9005, role: 'household-reserve', label: 'Invented reserve', value: 0, held: true },
];
const CATEGORIES = [{ id: 101, name: 'Groceries' }, { id: 106, name: 'Trip' }, { id: 107, name: 'Gifts' },
  { id: 108, name: 'Payroll', is_income: true }];
let nextId = 800000;
function lm(f) {
  const account = ACCOUNTS.find(a => a.id === (f.account || 'chequing-b'));
  const row = { id: f.id != null ? f.id : ++nextId, date: f.date, amount: f.amount.toFixed(2), currency: 'cad',
    payee: f.payee || 'Invented payee', original_name: f.payee || 'INVENTED PAYEE', notes: null,
    category_id: f.category ? CATEGORIES.find(c => c.name === f.category).id : null,
    plaid_account_id: account.providerId, is_pending: f.pending === true, status: f.pending ? 'pending' : 'cleared',
    tags: [], ...(f.tagIds ? { tag_ids: f.tagIds } : {}), ...(f.raw || {}) };
  return row;
}
const link = (kind, id, goalId, date) => ({ [kind === 'tag' ? 'tagId' : 'categoryId']: id,
  goalRef: { kind: 'commitment', id: goalId }, occurrenceDate: date, effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' });
// Two items in need-date order: trip 2026-11-20, gift 2026-12-10.
function world({ trip = 600, gift = 600, savings = 1000 } = {}) {
  return { savings, accounts: clone(ACCOUNTS),
    commitments: [
      { id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: trip, confidence: 'confirmed', sinkingFund: true },
      { id: 'gift', label: 'Invented gift', date: '2026-12-10', amount: gift, confidence: 'confirmed', sinkingFund: true }],
    links: [link('category', 106, 'trip', '2026-11-20')],
    tags: [{ id: 201, name: 'invented-trip-tag' }],
    transactions: [lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })] };
}
function served(w) {
  const sav = w.savings, plan = {
    opening: { asOf: AS_OF, priorAsOf: '2026-10-09', representedEvents: w.snapshot ? [{ id: 'payroll', date: '2026-10-09' }] : [],
      ...(w.snapshot ? { paydaySnapshot: { periodStart: '2026-10-09', asOf: '2026-10-09', opening: w.snapshot } } : {}) },
    defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
    startingCash: { breakdown: w.accounts.filter(a => !a.held).map(a => ({ id: a.id, label: a.label,
      value: a.id === 'savings' ? sav : a.value, evidenceDate: AS_OF, confidence: 'confirmed' })),
    heldElsewhere: [{ id: 'savings-dont-touch', value: 0, class: 'purpose-reserve' }] },
    income: [{ id: 'payroll', label: 'Invented salary', frequency: 'biweekly', anchor: '2026-10-09', amount: 1400, confidence: 'confirmed' }],
    bills: [], obligations: [], commitments: clone(w.commitments), groups: [], funding: { options: [] },
    budget: { categories: [{ id: 'groceries', label: 'Groceries', class: 'essential', plannedPayday: 300,
      confidence: 'confirmed', from: ['Groceries'] }] },
    savingsEarmarks: { version: 1, currency: 'CAD',
      history: [{ revision: 1, confirmedAt: '2026-10-01', source: 'Invented anchor confirmation', pools: [{ poolId: 'pool', allocations: [] }] }],
      allocationPolicy: { order: 'due-date-first-combined-pool', effectiveFrom: '2026-10-01', source: 'Invented owner policy' },
      pools: [{ id: 'pool', accountId: 'savings', label: 'Invented pool', role: 'purpose-reserve', purpose: 'Invented items',
        goalRefs: w.commitments.map(c => ({ kind: 'commitment', id: c.id })) },
      { id: 'reserve', accountId: 'savings-dont-touch', label: 'Invented reserve', role: 'purpose-reserve',
        purpose: 'Invented reserve', reconciledOn: AS_OF, goalRefs: [] }] },
    savingsPoolObservation: w.noObservation ? undefined : { asOf: AS_OF, accounts: [
      { accountId: 'savings', value: sav, currency: 'CAD', source: 'provider-observe:lunchmoney', evidenceDate: AS_OF, pendingState: 'clear' },
      { accountId: 'savings-dont-touch', value: 0, currency: 'CAD', source: 'provider-observe:lunchmoney', evidenceDate: AS_OF, pendingState: 'clear' }] } };
  if (w.noObservation) delete plan.savingsPoolObservation;
  const accountMap = { schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'a4b-test',
    ...(w.links ? { savingsLinks: { version: 1, anchorRevision: 1, links: w.links } } : {}),
    mappings: w.accounts.map(a => ({ providerAccountId: String(a.providerId), atlasRole: a.role,
      canonical: { id: a.id, collection: 'cash' } })) };
  const payload = { categories: CATEGORIES, tags: w.tags,
    plaid_accounts: w.accounts.filter(a => !(w.noObservation && a.id === 'savings')).map(a => ({ id: a.providerId,
      name: a.label, type: 'depository', balance: String(a.id === 'savings' ? sav : a.value), currency: 'cad',
      balance_last_update: AS_OF + 'T12:00:00.000Z' })),
    transactions: w.transactions,
    transactionWindow: { startDate: '2026-09-01', endDate: AS_OF, complete: true, hasMore: false, ...(w.window || {}) },
    pendingCoverage: { basis: 'is_pending-unbounded', complete: true, hasMore: false },
    fetchedAt: AS_OF + 'T18:00:00.000Z' };
  const identity = { rules: [{ eventId: 'payroll', payeePattern: 'Invented employer', atlasAccountId: 'chequing-a', direction: 'credit' }] };
  const data = { meta: { asOf: AS_OF, title: 'Invented A4b household' }, accounts: [], debts: [], revolvingExtra: [], plan };
  return Live.fromObservation({ data, payload, accountMap, identity }).data;
}
function page(w, extra = {}) {
  const data = served(w), o = data.liveOverlay;
  const opts = { debts: data.debts, currentPeriodActuals: o.currentPeriodActuals, operatingPlan: o.operatingPlan,
    observedCash: o.observedCash, ...extra };
  const before = JSON.stringify(data);
  const advice = F.recommend(data.plan, AS_OF, opts);
  assert.equal(JSON.stringify(data), before, 'Forecast never mutates the served document');
  const pub = F.savingsFundingPublication(advice.savingsFunding, { asOf: AS_OF, advice });
  return { data, packet: o.currentPeriodActuals, advice, pub, opts };
}
const row = (p, id) => p.pub.rows.find(r => r.key === 'commitment:' + id);
const fact = f => f && f.status === 'known' ? f.amount : f ? f.status : undefined;
const facts = (p, id) => { const r = row(p, id); return r && { saved: r.saved, needed: r.needed, still: r.stillToFund,
  paid: fact(r.commitmentCost?.confirmedLinkedPaid), unpaid: fact(r.commitmentCost?.unpaidCost) }; };
const stock = p => p.advice.savingsFunding.stock?.reportedStock?.amount ?? null;
const unallocated = p => p.advice.savingsFunding.backing?.unallocated ?? p.advice.savingsFunding.unallocated;
// The household Other row and named rows, from the active Budget period.
function household(p) {
  const v = p.advice.payPeriodViews.find(view => view.start <= AS_OF && view.end >= AS_OF);
  const rows = v.householdBudget?.rows || v.householdBudget?.categories || [];
  return { view: v, rows, text: JSON.stringify(v.householdBudget) };
}
const cls = (p, payee) => {
  const tx = p.packet.transactions.find(t => t.displayedPayee === payee || t.amount === payee);
  return F.classifyCurrentPeriodTransaction(tx, p.data.plan, { packet: p.packet, currentPeriodActuals: p.packet });
};

// ------------------------------------------------------- check 2: one pool
{
  // 1,000 and two 600 needs (Nov 20, Dec 10): Saved 600 / 400; later gap 200.
  const p = page(world());
  assert.deepEqual(facts(p, 'trip'), { saved: 600, needed: 600, still: 0, paid: 0, unpaid: 600 },
    'a linked trip with complete history and no purchase: Paid is an established 0, the need stays 600');
  assert.deepEqual([facts(p, 'gift').paid, facts(p, 'gift').unpaid], ['unconfigured', 'unconfigured'],
    'an unlinked item never gets a fabricated 0 Paid');
  assert.deepEqual([row(p, 'gift').saved, row(p, 'gift').stillToFund], [400, 200], 'partial last item: 400 saved, 200 to fund');
  assert.deepEqual([stock(p), unallocated(p)], [1000, 0], 'B 1,000 = 600 + 400 + unallocated 0');
}
{
  // Verified zero is a real zero; missing balance evidence is Unknown.
  const zero = page(world({ savings: 0 }));
  assert.deepEqual([row(zero, 'trip').saved, row(zero, 'gift').saved, row(zero, 'trip').stillToFund, row(zero, 'gift').stillToFund],
    [0, 0, 600, 600], 'verified 0 pool: Saved 0 / 0, still 600 / 600');
  const missing = page({ ...world(), noObservation: true });
  assert.deepEqual([row(missing, 'trip').saved, row(missing, 'trip').stillToFund, row(missing, 'trip').stillToFundTrust],
    [null, null, 'unknown'], 'missing balance: Saved and Still to fund are Unknown, never 0 or 600');
}
{
  // Completed from Savings for 500 or 700 (owner-confirmed): B is the
  // observed balance after the purchase, never debited again; the later
  // item receives exactly that remainder. 1,000 -> 500 or 300 left.
  for (const [actual, left] of [[500, 500], [700, 300]]) {
    const w = world({ savings: left });
    w.commitments[0].settledOn = '2026-10-12';
    w.transactions.push(lm({ date: '2026-10-12', amount: actual, category: 'Trip', account: 'savings', payee: 'Invented airline' }));
    const p = page(w);
    assert.equal(stock(p), left, 'observed Savings ' + left + ' after the ' + actual + ' purchase');
    assert.deepEqual([row(p, 'gift').saved, row(p, 'gift').stillToFund, unallocated(p)], [left, 600 - left, 0],
      'completed for ' + actual + ': ' + left + ' is left for the gift; no variance credit and no second debit');
    // A5 (R5): the owner-confirmed item stays listed this pay period as an
    // owner-confirmed Paid display row that draws nothing from the pool.
    const trip = row(p, 'trip');
    assert.deepEqual([trip?.paymentStatus, trip?.paymentSource, trip?.confirmedOn, trip?.saved, trip?.needed, trip?.stillToFund],
      ['paid', 'owner-confirmed', '2026-10-12', 0, 0, 0], 'the confirmed item draws nothing more from the pool');
  }
}
{
  // Not confirmed, part-paid from Savings: 500 of a 600 trip. U = 100.
  // B is the observed 500: trip 100, gift 400, gap 200. Nothing is added
  // back to the pool for the 100 not yet spent (R4 once).
  const w = world({ savings: 500 });
  w.transactions.push(lm({ date: '2026-10-12', amount: 500, category: 'Trip', account: 'savings', payee: 'Invented airline' }));
  const p = page(w);
  assert.deepEqual(facts(p, 'trip'), { saved: 100, needed: 100, still: 0, paid: 500, unpaid: 100 });
  assert.deepEqual([row(p, 'gift').saved, row(p, 'gift').stillToFund, unallocated(p)], [400, 200, 0]);
}

// --------------------------------------------- check 3: trip spending once
{
  // Prepaid 100 from chequing (blueprint section 3): needs 500 then 700,
  // pool 1,000. Trip P 100, U 400 -> shares 400 / 600, gift gap 100.
  // Savings cash stays 1,000; Household and Other exclude the purchase.
  const w = world({ trip: 500, gift: 700 });
  w.transactions.push(lm({ date: '2026-10-11', amount: 100, category: 'Trip', payee: 'Invented airline' }));
  const p = page(w);
  assert.deepEqual(facts(p, 'trip'), { saved: 400, needed: 400, still: 0, paid: 100, unpaid: 400 });
  assert.deepEqual([row(p, 'gift').saved, row(p, 'gift').stillToFund], [600, 100]);
  assert.deepEqual([stock(p), unallocated(p)], [1000, 0], 'Savings cash is not fictitiously withdrawn');
  const c = cls(p, 'Invented airline');
  assert.deepEqual([c.kind, c.householdSpending, c.occurrenceKey], ['savings-item', false, 'trip@2026-11-20']);
  const h = household(p);
  assert.doesNotMatch(h.text, /Invented airline/, 'the item purchase is not a Household or Other row');
  // The same purchase without the link stays Other, unchanged (control).
  const plain = page({ ...w, links: null });
  assert.match(household(plain).text, /Invented airline/, 'control: an unlinked purchase stays in Other');
  assert.deepEqual(facts(plain, 'trip').saved, 500, 'control: no link, no item effect');
}
{
  // Refund: 100 spent, 30 refunded -> net 70, need 430, allocation 430,
  // once. The refund is never income or Other.
  const w = world({ trip: 500, gift: 700 });
  w.transactions.push(lm({ date: '2026-10-10', amount: 100, category: 'Trip', payee: 'Invented airline' }),
    lm({ date: '2026-10-12', amount: -30, category: 'Trip', payee: 'Invented airline refund' }));
  const p = page(w);
  assert.deepEqual(facts(p, 'trip'), { saved: 430, needed: 430, still: 0, paid: 70, unpaid: 430 });
  assert.deepEqual([row(p, 'gift').saved, row(p, 'gift').stillToFund], [570, 130]);
  assert.equal(cls(p, -30).kind, 'savings-item', 'the linked refund belongs to the item');
  assert.doesNotMatch(JSON.stringify(p.advice.payPeriodViews[0].otherIncome || null), /refund/i, 'a refund is never income');
  // Reversal of the whole 100: net 0, need back to 500.
  const r = world({ trip: 500, gift: 700 });
  r.transactions.push(lm({ date: '2026-10-10', amount: 100, category: 'Trip', payee: 'Invented airline' }),
    lm({ date: '2026-10-11', amount: -100, category: 'Trip', payee: 'Invented airline' }));
  assert.deepEqual(facts(page(r), 'trip'), { saved: 500, needed: 500, still: 0, paid: 0, unpaid: 500 });
}
{
  // Category and tag both name the trip: 60 counts once, never 120.
  const w = world({ trip: 500, gift: 700 });
  w.links.push(link('tag', 201, 'trip', '2026-11-20'));
  w.transactions.push(lm({ date: '2026-10-11', amount: 60, category: 'Trip', tagIds: [201], payee: 'Invented ferry' }));
  assert.deepEqual(facts(page(w), 'trip'), { saved: 440, needed: 440, still: 0, paid: 60, unpaid: 440 });
}
{
  // A purchase made before the item period, inside covered history.
  const w = world({ trip: 500, gift: 700 });
  w.transactions.push(lm({ date: '2026-09-05', amount: 100, category: 'Trip', payee: 'Invented early booking' }));
  assert.deepEqual(facts(page(w), 'trip').paid, 100, 'no creation-date cutoff');
}

// ------------------------------------------------- Savings versus chequing
{
  // The same 100 from Savings (observed 900) or from chequing (observed
  // 1,000): the trip is 100 paid / 400 needed either way. Savings is never
  // reduced twice; only the observed balance differs, and the gift gets it.
  const viaSavings = world({ trip: 500, gift: 700, savings: 900 });
  viaSavings.transactions.push(lm({ date: '2026-10-11', amount: 100, category: 'Trip', account: 'savings', payee: 'Invented airline' }));
  const viaChequing = world({ trip: 500, gift: 700, savings: 1000 });
  viaChequing.transactions.push(lm({ date: '2026-10-11', amount: 100, category: 'Trip', payee: 'Invented airline' }));
  const s = page(viaSavings), c = page(viaChequing);
  assert.deepEqual(facts(s, 'trip'), facts(c, 'trip'), 'one item position whichever account paid');
  assert.deepEqual([stock(s), row(s, 'gift').saved, row(s, 'gift').stillToFund], [900, 500, 200]);
  assert.deepEqual([stock(c), row(c, 'gift').saved, row(c, 'gift').stillToFund], [1000, 600, 100]);
}

// ------------------------- the active close deducts an item purchase once
{
  // Leaving the household hold must not lose the cash. Chequing purchase:
  // the close deducts it through its item term, equal to the unlinked
  // control where the hold deducted it. Savings-account purchase: it is in
  // observed Savings, so the household close equals the no-purchase world.
  const close = p => { const v = p.advice.payPeriodViews.find(view => view.start <= AS_OF && view.end >= AS_OF);
    return [v.plannedPeriodClose, v.plannedPeriodCloseTerms?.savingsItemSpending ?? 0]; };
  const snap = o => ({ ...world({ trip: 500, gift: 700, ...o }), snapshot: 2000 });
  const viaChequing = snap();
  viaChequing.transactions.push(lm({ date: '2026-10-11', amount: 100, category: 'Trip', payee: 'Invented airline' }));
  const linked = close(page(viaChequing)), unlinked = close(page({ ...viaChequing, links: null }));
  assert.equal(linked[1], 100, 'the close names the 100 item term');
  assert.equal(linked[0], unlinked[0], 'chequing item purchase: the close deducts it exactly once, as before');
  const none = close(page(snap()));
  assert.equal(typeof none[0], 'number', 'the dated payday snapshot gives a known close');
  assert.equal(Math.round((none[0] - linked[0]) * 100), 10000, 'the close is 100 below the no-purchase world');
  const viaSavings = snap({ savings: 900 });
  viaSavings.transactions.push(lm({ date: '2026-10-11', amount: 100, category: 'Trip', account: 'savings', payee: 'Invented airline' }));
  const s = close(page(viaSavings));
  assert.deepEqual(s, [none[0], 0], 'a Savings-account item purchase is never also a household deduction');
}

// ------------------------------------- withheld evidence stays Unknown, visible
{
  // Ambiguous: the category names two items. Neither receives the 80; the
  // purchase stays in Household/Other once and both items keep their need.
  const w = world({ trip: 300, gift: 300 });
  w.links.push(link('category', 106, 'gift', '2026-12-10'));
  w.transactions.push(lm({ date: '2026-10-11', amount: 80, category: 'Trip', payee: 'Invented outfitter' }));
  const p = page(w);
  assert.equal(cls(p, 'Invented outfitter').kind !== 'savings-item', true, 'unresolved attribution is not membership');
  assert.deepEqual([row(p, 'trip').needed, row(p, 'gift').needed, row(p, 'trip').saved, row(p, 'gift').saved],
    [null, null, null, null], 'no guessed allocation: attribution and the dependent totals are Unknown');
  assert.equal(stock(p), 1000, 'the independently known pool stays visible');
  assert.match(household(p).text, /Invented outfitter/, 'the purchase stays visible once');
}
{
  // Pending linked charge: attribution is the item's, totals Unknown, and
  // its pending cash still counts in the cash walk (display membership
  // only). Pool allocation withholds rather than inventing a need.
  const w = world({ trip: 500, gift: 700 });
  w.transactions.push(lm({ date: '2026-10-13', amount: 100, category: 'Trip', payee: 'Invented airline', pending: true }));
  const p = page(w);
  assert.equal(row(p, 'trip').needed, null, 'pending item evidence: the need is Unknown');
  assert.equal(row(p, 'trip').saved, null, 'and the dependent backing is withheld');
  // Display membership never drops cash: the engine's own pending-cash
  // reading (loaded in a VM with that one reader exposed, as the A4a
  // still-to-fund parity does) is 100 with or without the link.
  const vm = require('node:vm'), fs = require('node:fs');
  const ctx = { module: { exports: {} }, exports: {}, console };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/forecast.js'), 'utf8')
    .replace('const Forecast = {', 'const Forecast = { __sumCategoryActuals: sumCategoryActuals,'), ctx);
  const pendingCash = world => { const d = served(world);
    return ctx.module.exports.__sumCategoryActuals(d.plan, AS_OF, null, { currentPeriodActuals: d.liveOverlay.currentPeriodActuals }); };
  const linked = pendingCash(w), unlinked = pendingCash({ ...w, links: null });
  assert.deepEqual([linked.pendingCash, unlinked.pendingCash], [100, 100], 'pending item cash still encumbers household cash');
  assert.equal(linked.excluded.savingsItems, 100, 'and is reported as item spending, not household');
}

// --------------------------------- A4a findings 6 and 7: split parent, pair
{
  // A split parent with its children present is excluded; the qualified
  // child decides (100 of a 150 parent is Trip, 50 is Groceries).
  const w = world({ trip: 500, gift: 700 });
  w.transactions.push(lm({ id: 700001, date: '2026-10-11', amount: 150, category: 'Trip', payee: 'Invented store', raw: { is_group: true } }),
    lm({ id: 700002, date: '2026-10-11', amount: 100, category: 'Trip', payee: 'Invented store', raw: { parent_id: 700001 } }),
    lm({ id: 700003, date: '2026-10-11', amount: 50, category: 'Groceries', payee: 'Invented store', raw: { parent_id: 700001 } }));
  const p = page(w);
  assert.deepEqual(facts(p, 'trip'), { saved: 400, needed: 400, still: 0, paid: 100, unpaid: 400 },
    'the child counts once; the parent never makes the item Unknown');
  // A unique pending/posted pair: the posted successor counts once.
  const q = world({ trip: 500, gift: 700 });
  q.transactions.push(lm({ date: '2026-10-11', amount: 100, category: 'Trip', payee: 'Invented airline', pending: true }),
    lm({ date: '2026-10-11', amount: 100, category: 'Trip', payee: 'Invented airline' }));
  assert.deepEqual(facts(page(q), 'trip'), { saved: 400, needed: 400, still: 0, paid: 100, unpaid: 400 },
    'pending replaced by its posted successor: 100 once, never 200 and never Unknown');
  // An ambiguous pair (two posted candidates) stays Unknown.
  const z = world({ trip: 500, gift: 700 });
  z.transactions.push(lm({ date: '2026-10-11', amount: 100, category: 'Trip', payee: 'Invented airline', pending: true }),
    lm({ date: '2026-10-11', amount: 100, category: 'Trip', payee: 'Invented airline' }),
    lm({ date: '2026-10-11', amount: 100, category: 'Trip', payee: 'Invented airline' }));
  assert.equal(facts(page(z), 'trip').needed, null, 'an unproven replacement keeps the item Unknown');
}

// ------------------------------- owner partial overlapping a charge and refund
{
  // Owner partial 50 that overlaps a charge of 50, with a refund of 20:
  // P = N + C - X = 30 + 50 - 50 = 30, not 80. Need 500 - 30 = 470.
  const w = world({ trip: 500, gift: 700 });
  w.transactions.push(lm({ date: '2026-10-10', amount: 50, category: 'Trip', payee: 'Invented deposit' }),
    lm({ date: '2026-10-12', amount: -20, category: 'Trip', payee: 'Invented deposit refund' }));
  const base = page(w);
  const charge = base.packet.transactions.find(t => t.displayedPayee === 'Invented deposit').id;
  const confirmation = { occurrenceKey: 'trip@2026-11-20', status: 'partial', cents: 5000, confirmedOn: '2026-10-12' };
  const overlapped = page(w, { savingsConfirmations: [{ ...confirmation, overlapRefs: [charge] }] });
  assert.deepEqual(facts(overlapped, 'trip'), { saved: 470, needed: 470, still: 0, paid: 30, unpaid: 470 }, '30, not 80');
  const blind = page(w, { savingsConfirmations: [confirmation] });
  assert.equal(facts(blind, 'trip').needed, null, 'an unknown overlap is Unknown: no blind sum or max');
  assert.deepEqual(facts(base, 'trip').paid, 30, 'without the owner amount: net transactions alone, 30');
}

// ------------------- a link that names an unresolvable item: Paid Unknown
{
  // Lead check note 4: the link names the trip, but no trip occurrence is
  // on its occurrence date, so the ledger cannot resolve the item. Its Paid
  // fact is Unknown ('unavailable'), never 'unconfigured' as if no link
  // existed; the unlinked gift keeps 'unconfigured'.
  const w = world({ trip: 500, gift: 700 });
  w.links = [link('category', 106, 'trip', '2026-11-21')];
  const p = page(w);
  assert.equal(row(p, 'trip').commitmentCost.confirmedLinkedPaid.status, 'unavailable', 'named but unresolved: Unknown');
  assert.equal(row(p, 'gift').commitmentCost.confirmedLinkedPaid.status, 'unconfigured', 'unlinked: unconfigured');
}

// ---------------- Atlas P1 on 4d90a156: unresolved named item withholds need
{
  // The link names the trip on 2026-11-21 (no occurrence; the trip is on
  // 2026-11-20) and a posted 100 Trip purchase is in the window. The item
  // cannot be resolved, so its P and U are Unknown: Needed, Saved and Still
  // to fund are withheld, and so is every later share (no allocation is
  // walked past an Unknown need). The original cost 500 and stock 1,000
  // stay known and visible.
  const w = world({ trip: 500, gift: 700 });
  w.links = [link('category', 106, 'trip', '2026-11-21')];
  w.transactions.push(lm({ date: '2026-10-11', amount: 100, category: 'Trip', payee: 'Invented airline' }));
  const p = page(w), trip = row(p, 'trip'), gift = row(p, 'gift');
  assert.deepEqual([trip.needed, trip.saved, trip.stillToFund], [null, null, null], 'trip need and allocation withheld');
  assert.deepEqual([gift.saved, gift.stillToFund], [null, null], 'no later share is walked past the Unknown need');
  assert.equal(fact(trip.commitmentCost.originalCost), 500, 'original cost stays known');
  assert.equal(fact(trip.commitmentCost.confirmedLinkedPaid), 'unavailable');
  assert.equal(stock(p), 1000, 'the known stock stays visible');
}

// ------- Atlas P2 on 4d90a156: a completed period keeps its item deduction
{
  // A posted 100 Trip purchase from chequing on Sep 30, inside the completed
  // Sep 25 - Oct 8 pay period. Its household actuals exclude the item
  // purchase, so its Balance After Deductions deducts it once under the
  // item term: equal to the unlinked control, never 100 higher.
  const lookback = p => p.advice.payPeriodViews.find(v => v.start === '2026-09-25' && v.end === '2026-10-08');
  const w = world({ trip: 500, gift: 700 });
  w.transactions.push(lm({ date: '2026-09-30', amount: 100, category: 'Trip', payee: 'Invented airline' }));
  const linked = lookback(page(w)), plain = lookback(page({ ...w, links: null }));
  assert(linked && plain, 'the completed period is published');
  assert.equal(typeof plain.balanceAfterDeductions, 'number');
  assert.equal(linked.balanceAfterDeductions, plain.balanceAfterDeductions, 'attribution never makes the expense vanish');
  assert.equal(linked.predictedEndingBalanceTerms.savingsItemSpending, 100, 'deducted once as the item term');
  assert.equal(linked.predictedEndingBalanceTerms.closes, true, 'the published terms reconcile');
}

// -- lead pre-review of 0d919cb5: the item term follows the hold's coverage
{
  // The completed-period item term applies only where that period's own
  // actuals are covered (the hold's spentReady). Otherwise the hold deducts
  // no observed spending and neither does the item term: linked equals
  // unlinked. (a) Aug 28 - Sep 10 starts before the Sep 1 window, purchase
  // Sep 5; (b) a partly covered window (hasMore), purchase Sep 30 in the
  // Sep 25 - Oct 8 period.
  const period = (p, start) => p.advice.payPeriodViews.find(v => v.start === start);
  for (const [label, date, start, window] of [
    ['period before the window', '2026-09-05', '2026-08-28', null],
    ['partly covered window', '2026-09-30', '2026-09-25', { complete: false, hasMore: true }]]) {
    const w = world({ trip: 500, gift: 700 });
    if (window) w.window = window;
    w.transactions.push(lm({ date, amount: 100, category: 'Trip', payee: 'Invented airline' }));
    const linked = period(page(w), start), plain = period(page({ ...w, links: null }), start);
    assert(linked && plain, label + ': the period is published');
    assert.equal(linked.balanceAfterDeductions, plain.balanceAfterDeductions, label + ': linked equals unlinked');
    assert.equal(linked.predictedEndingBalanceTerms?.savingsItemSpending, undefined, label + ': no item term without covered actuals');
  }
}

// ----------------------------------------------------- reload idempotence
{
  const w = world({ trip: 500, gift: 700 });
  w.transactions.push(lm({ date: '2026-10-11', amount: 100, category: 'Trip', payee: 'Invented airline' }));
  const a = page(w), b = page(w);
  assert.equal(JSON.stringify(a.advice), JSON.stringify(b.advice), 'a reload of the same observation moves nothing');
  const again = F.recommend(a.data.plan, AS_OF, a.opts);
  assert.equal(JSON.stringify(again), JSON.stringify(a.advice), 'recomputing in one session is identical (no cache leak)');
}

// ------------------------------------------- production byte-identity control
{
  // No configured links (production today): the packet carries no
  // savingsLinks, so every Forecast output equals the same input with the
  // link block removed at the account map.
  const w = world({ trip: 500, gift: 700 });
  w.transactions.push(lm({ date: '2026-10-11', amount: 100, category: 'Trip', payee: 'Invented airline' }));
  const off = page({ ...w, links: null });
  assert.equal(off.packet.savingsLinks, undefined);
  assert.deepEqual([facts(off, 'trip').needed, facts(off, 'trip').paid], [500, 'unconfigured']);
}
console.log('A4b routing: check 2 and 3 scenarios, Savings vs chequing, withheld evidence, split/pair, owner overlap and reload passed.');
