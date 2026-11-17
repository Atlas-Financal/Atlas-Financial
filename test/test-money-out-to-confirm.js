'use strict';
// Money out, to confirm (Grok Bot's rule 17 answer on transfers; owner-approved audit, 1.0).
// A POSTED chequing debit filed as Transfer or Payment, with no other side proven through the
// ledger (a transfer group, link or mark; never a name or amount match), left cash, so it
// reduces the Budget's remainder ONCE as its own named term, "Money out, to confirm". It is not
// Other spending. A pending one is shown separately and is not added in. A proven card payment
// counts once, on the card side; a proven move between household accounts moves nothing out.
// Before this, the same $400 filed as Transfer left the remainder untouched (1,632.01) while
// filed as Shopping it reduced it (1,232.01). The printed terms must sum to the printed total.
// Invented data only: the Budget surface household plus extra legs; every expected figure is
// the fixture's own literal (remainder before the leg 1,632.01 = 4,050 - 1,665 - 752.99).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const fx = require('./fixtures/budget-surface-data');
const { world } = require('./fixtures/money-out-worlds');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function ok(cond, msg, detail) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${msg}${!cond && detail ? `  — ${detail}` : ''}`);
  if (!cond) failures++;
}
function stubEl() {
  return { innerHTML: '', textContent: '', hidden: false, value: '',
    style: { setProperty() {}, getPropertyValue() { return ''; } }, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, hasAttribute() { return false; },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild() {}, insertAdjacentHTML() {}, closest() { return null; }, children: [] };
}

// Load the Budget page scripts in index.html order.
function page() {
  const els = new Map();
  const context = vm.createContext({ Forecast: F, console, addEventListener() {}, setTimeout, clearTimeout,
    document: { addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
      getElementById(id) { if (!els.has(id)) els.set(id, stubEl()); return els.get(id); },
      documentElement: { dataset: {}, style: {} }, createElement: stubEl, createElementNS: stubEl, body: stubEl() },
    window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  // In a browser window is the global object; page scripts register on it.
  context.window = Object.assign(context, { matchMedia() { return { matches: false, addEventListener() {} }; } });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8'), context);
  vm.runInContext('App.boot = () => {}; App.once = () => {}; App.register = () => {};', context);
  for (const f of ['forecast-chequing.js', 'balance-history.js', 'bill-detail.js', 'savings-inventory.js',
    'budget-surface.js', 'plan.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), context);
  }
  // Charts need a real SVG DOM; they are not part of this surface.
  vm.runInContext('forecastChart = () => {}; renderCalendar = () => {};', context);
  vm.runInContext(`globalThis.__retainedCalls = 0;
    const __retained = operatingSurfaceHtml;
    operatingSurfaceHtml = function (ctx) { globalThis.__retainedCalls++; return __retained(ctx); };
    const __active = budgetSurfaceHtml;
    budgetSurfaceHtml = function (ctx) { globalThis.__ctx = ctx; return __active(ctx); };`, context);
  return {
    context,
    render(served) {
      context.served = served;
      // App.boot sets App.data to the served packet before renderPlan runs.
      vm.runInContext("Object.defineProperty(App, 'data', { get: () => served, configurable: true });", context);
      vm.runInContext('Object.assign(state, served.plan.defaults, { debts: served.debts }); renderPlan(served, null, null);', context);
      return els.get('operating-surface-body').innerHTML;
    },
    rerender(js) { return vm.runInContext(`${js}; budgetSurfaceHtml(__ctx)`, context); },
  };
}


const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const cents = n => Math.round(Number(n) * 100);
function run(legs, options) {
  const p = page();
  const html = p.render(world(legs, options));
  const ctx = p.context.__ctx;
  const cur = ctx.advice.payPeriodViews.find(view => view.timelineRole === 'current');
  return { html, cur, terms: cur.predictedEndingBalanceTerms, other: (cur.householdBudget || []).find(row => row.id === 'other-spending') };
}
const BEFORE = 1632.01; // 4,050 income - 1,665 bills - 752.99 household hold: hand-derived from the fixture header
const DEBIT = 400;
const transfer = { category: 'transfer', amount: DEBIT };

console.log('\n=== the same $400 moves the remainder by the same amount however it is filed ===');
const control = run([]);
const shopping = run([{ category: 'shopping', amount: DEBIT }]);
const unproven = run([transfer]);
ok(cents(control.cur.balanceAfterDeductions) === cents(BEFORE), 'control: the remainder is 1,632.01', String(control.cur.balanceAfterDeductions));
ok(cents(shopping.cur.balanceAfterDeductions) === cents(BEFORE - DEBIT), 'filed as Shopping: the remainder falls by 400.00', String(shopping.cur.balanceAfterDeductions));
ok(cents(unproven.cur.balanceAfterDeductions) === cents(shopping.cur.balanceAfterDeductions),
  'filed as Transfer with no proven other side: the remainder falls by the same 400.00', String(unproven.cur.balanceAfterDeductions));
ok(cents(unproven.cur.afterHouseholdBudget) === cents(shopping.cur.afterHouseholdBudget), 'the household remainder agrees too');
ok(unproven.terms?.moneyOutToConfirm === DEBIT && unproven.terms.closes === true,
  'the 400 is its own published term and the terms still close', JSON.stringify(unproven.terms));
ok(unproven.other?.spent === control.other?.spent, 'it is not Other spending (Other is unchanged)', JSON.stringify([unproven.other?.spent, control.other?.spent]));
ok(unproven.cur.balanceAfterDeductionsTrust === 'estimated',
  'the remainder reads estimated while a money-out term to confirm stands (never more certain; the fixture is already estimated through its partner pay)', unproven.cur.balanceAfterDeductionsTrust);
ok(unproven.cur.moneyOutToConfirm?.posted === DEBIT && unproven.cur.moneyOutToConfirm.pending === 0, 'the period publishes the posted amount');
ok(!shopping.terms?.moneyOutToConfirm && !control.terms?.moneyOutToConfirm, 'a Shopping debit or no debit publishes no money-out term');
const paymentLabel = run([{ category: 'payment', amount: DEBIT }]);
ok(cents(paymentLabel.cur.balanceAfterDeductions) === cents(BEFORE - DEBIT) && paymentLabel.terms?.moneyOutToConfirm === DEBIT,
  'filed as Payment, Transfer: the same, once');

console.log('\n=== the printed parts sum to the printed total ===');
{
  const row = key => (unproven.html.match(new RegExp('data-bad-term="' + key + '"[\\s\\S]*?data-bad-term-amount>([^<]*)<')) || [])[1];
  const printed = ['periodIncome', 'assignedBills', 'householdBudgetHold', 'moneyOutToConfirm', 'balanceAfterDeductions'].map(row);
  const n = text => (text == null ? null : cents(String(text).replace(/[^0-9.\-]/g, '')));
  ok(printed.every(value => value != null), 'every term, the money-out term included, is printed', JSON.stringify(printed));
  ok(n(printed[0]) - n(printed[1]) - n(printed[2]) - n(printed[3]) === n(printed[4]),
    'income - bills - household - money out = the printed remainder', JSON.stringify(printed));
  ok(/Money out, to confirm/.test(text(unproven.html)) && (unproven.html.match(/data-bad-term="moneyOutToConfirm"/g) || []).length === 1,
    'the term is labelled Money out, to confirm and printed once');
  ok(!/data-bad-term="moneyOutToConfirm"/.test(shopping.html), 'no such line on a Shopping debit');
}

console.log('\n=== a pending debit is shown separately and is not added in ===');
{
  const pending = run([{ category: 'transfer', amount: DEBIT, pending: true }]);
  ok(cents(pending.cur.balanceAfterDeductions) === cents(BEFORE) && !pending.terms?.moneyOutToConfirm,
    'the remainder is unchanged and there is no term', String(pending.cur.balanceAfterDeductions));
  ok(pending.cur.moneyOutToConfirm?.pending === DEBIT && pending.cur.moneyOutToConfirm.posted === 0, 'the pending amount is published separately', JSON.stringify(pending.cur.moneyOutToConfirm));
  ok(/data-money-out-pending/.test(pending.html) && /Pending money out, to confirm: \$400\.00/.test(text(pending.html)),
    'the page says so, and that it is not counted until it posts');
}

console.log('\n=== a debit another owner already counts is counted once, there ===');
{
  // The invented mortgage payment (1,400, Aug 15) is linked to its scheduled bill. Re-filed in the
  // ledger as Transfer or as Payment, Transfer, it is still that bill's payment: the bill side counts
  // it once and it is never money out as well (it left the remainder at 232.01 before this was fixed).
  for (const label of ['transfer', 'payment']) {
    const refiled = run([], { refile: { 92002: label } });
    ok(cents(refiled.cur.balanceAfterDeductions) === cents(BEFORE),
      'the linked 1,400 mortgage payment filed as ' + label + ': the remainder is unchanged at 1,632.01', String(refiled.cur.balanceAfterDeductions));
    ok(!refiled.terms?.moneyOutToConfirm && refiled.cur.moneyOutToConfirm == null,
      'filed as ' + label + ': no money-out term is published', JSON.stringify(refiled.cur.moneyOutToConfirm));
    ok(refiled.cur.periodBillLoad === control.cur.periodBillLoad, 'filed as ' + label + ': the bill load is the same 1,665, counted once as the bill');
  }
}

console.log('\n=== only a payment the card ledger ACCEPTED is proven; a generic payment hint is not proof ===');
{
  // Atlas's second blocker on #1149. The exclusion used the declared records in the plan, so a record the reconciler
  // rejected (unconfirmed, or naming a card credit that does not exist) hid the money-out term and the remainder
  // showed 1,632.01 - 400 with no estimate. It must use the pairs the reconciler accepted.
  const declare = record => {
    const served = world([transfer]);
    const tx = (served.liveOverlay.currentPeriodActuals.transactions || []).find(row => row.amount === DEBIT);
    served.plan.cardPurchaseCoverage.payments = [record(tx)];
    const advice = F.recommend(served.plan, '2026-08-20', { ...served.plan.defaults, debts: served.debts || [],
      currentPeriodActuals: served.liveOverlay.currentPeriodActuals, representedEvents: served.liveOverlay.representedEvents });
    const cur = advice.payPeriodViews.find(view => view.timelineRole === 'current');
    return { cur, terms: cur.predictedEndingBalanceTerms };
  };
  for (const [label, record] of [
    ['an unconfirmed declaration', tx => ({ id: 'decl-a', confirmed: false, debitRef: tx.coverageRef, creditRef: 'card-credit-a', allocations: [], otherAmount: DEBIT })],
    ['a declaration naming a card credit that does not exist', tx => ({ id: 'decl-b', confirmed: true, debitRef: tx.coverageRef, creditRef: 'no-such-credit', allocations: [], otherAmount: DEBIT })],
  ]) {
    const out = declare(record);
    ok(cents(out.cur.balanceAfterDeductions) === cents(BEFORE - DEBIT) && out.terms?.moneyOutToConfirm === DEBIT && out.cur.balanceAfterDeductionsTrust === 'estimated',
      label + ' proves nothing: the 400 still reduces the remainder once, as Money out, to confirm, estimated', JSON.stringify([out.cur.balanceAfterDeductions, out.terms?.moneyOutToConfirm, out.cur.balanceAfterDeductionsTrust]));
  }
  // A generic payment kind hint is not another owner counting the debit: with no card pair it is money out too.
  for (const kind of ['payment', 'bill-payment']) {
    const hinted = run([{ category: 'transfer', amount: DEBIT, kind }]);
    ok(cents(hinted.cur.balanceAfterDeductions) === cents(BEFORE - DEBIT) && hinted.terms?.moneyOutToConfirm === DEBIT,
      'a Transfer carrying the provider kind "' + kind + '" and no card pair reduces the remainder once', String(hinted.cur.balanceAfterDeductions));
  }
}

console.log('\n=== a card payment the card ledger ACCEPTED counts once, on the card side; one it does not accept counts once, here ===');
{
  // Grok Bot's condition: test the paired AND the unpaired case. An invented 400 card purchase (Aug 18, on the card) is paid by a
  // 400 chequing-a Transfer (Aug 19) and the card-side credit of 400. The only variable is whether the card-coverage ledger
  // accepts the pair (the funding account is chequing-a, so this is the pair the card tiles themselves use).
  const CARD = 400;
  const pay = r => ({ id: 'pay-1', confirmed: true, debitRef: r.debit, creditRef: r.credit, allocations: [{ purchaseRef: r.purchase, amount: CARD }], otherAmount: 0 });
  const leg = [{ category: 'transfer', amount: CARD, account: 1001 }];
  const view = (legs, card) => {
    const served = world(legs, { card });
    const advice = F.recommend(served.plan, '2026-08-20', { ...served.plan.defaults, debts: served.debts || [],
      currentPeriodActuals: served.liveOverlay.currentPeriodActuals, representedEvents: served.liveOverlay.representedEvents });
    const cur = advice.payPeriodViews.find(row => row.timelineRole === 'current');
    return { cur, terms: cur.predictedEndingBalanceTerms };
  };
  const purchaseOnly = view([], { amount: CARD });
  ok(cents(purchaseOnly.cur.balanceAfterDeductions) === cents(BEFORE - CARD) && !purchaseOnly.terms?.moneyOutToConfirm,
    'control: the card purchase alone lowers the remainder once (1,232.01), with no money-out term', String(purchaseOnly.cur.balanceAfterDeductions));
  // Paired (accepted): the cash leg is the card payment, counted once on the card side. Not money out, and the money is counted exactly once.
  const paired = view(leg, { amount: CARD, declare: pay });
  ok(cents(paired.cur.balanceAfterDeductions) === cents(purchaseOnly.cur.balanceAfterDeductions) && !paired.terms?.moneyOutToConfirm && paired.cur.moneyOutToConfirm == null,
    'an accepted card pair: no money-out term, and the remainder is exactly the purchase counted once (the payment is not deducted again)',
    JSON.stringify([paired.cur.balanceAfterDeductions, paired.terms?.moneyOutToConfirm]));
  // Unpaired (no declaration): the same cash leg proves nothing and reduces the remainder once, as Money out, to confirm.
  const unpaired = view(leg, { amount: CARD });
  ok(cents(unpaired.cur.balanceAfterDeductions) === cents(purchaseOnly.cur.balanceAfterDeductions - CARD) && unpaired.terms?.moneyOutToConfirm === CARD
    && unpaired.cur.balanceAfterDeductionsTrust === 'estimated',
    'the same legs with no accepted pair: the 400 reduces the remainder once, as Money out, to confirm, estimated',
    JSON.stringify([unpaired.cur.balanceAfterDeductions, unpaired.terms?.moneyOutToConfirm, unpaired.cur.balanceAfterDeductionsTrust]));
  // A pair the reconciler links but does not leave reconciled (a second record claims the same credit: the identity is in conflict)
  // proves nothing either: it counts once, as Money out. Only a payment whose status is reconciled is proof.
  const conflicted = view(leg, { amount: CARD, declare: r => [pay(r), { ...pay(r), id: 'pay-2' }] });
  ok(cents(conflicted.cur.balanceAfterDeductions) === cents(purchaseOnly.cur.balanceAfterDeductions - CARD) && conflicted.terms?.moneyOutToConfirm === CARD,
    'a pair claimed twice (not left reconciled) proves nothing: the 400 counts once, as Money out, to confirm',
    JSON.stringify([conflicted.cur.balanceAfterDeductions, conflicted.terms?.moneyOutToConfirm]));
}

console.log('\n=== a "minimum payment" label alone is not proof; only the minimum-payment owner\'s own exact category recognition keeps a debit out ===');
{
  // Atlas's finding on 54c2dd17: a "minimum payment" prefix skip hid unowned debits. The owner's exact recognition
  // (scripts/card-minimum-category.js categoryDebt: one of five exact names, both exclude flags set) is read by the observer
  // and stamped on the packet row; Forecast keeps only such a debit out of this term. The debit is a generic provider 'payment'
  // of 60 on chequing-a, Aug 18 (inside the cycle, outside the near-due window, so no other owner is involved).
  const MIN = 60, CARDMIN = 'Minimum payment - TD Travel Visa';
  const leg = (categoryName, extra) => [{ account: 1001, amount: MIN, kind: 'payment', payee: 'Synthetic card issuer', date: '2026-08-18', categoryName, ...(extra || {}) }];
  const control = run([]);
  const counts = (result, label) => ok(cents(result.cur.balanceAfterDeductions) === cents(control.cur.balanceAfterDeductions - MIN)
    && result.terms?.moneyOutToConfirm === MIN && result.cur.balanceAfterDeductionsTrust === 'estimated',
    label + ': the 60 reduces the remainder once, as Money out, to confirm, estimated', JSON.stringify([result.cur.balanceAfterDeductions, result.terms?.moneyOutToConfirm]));
  counts(run(leg('Minimum payment - Invented unconnected destination')), 'a "Minimum payment - ..." label naming no card the owner knows');
  counts(run(leg('Minimum payment service fee')), 'a "Minimum payment service fee" label');
  counts(run(leg(CARDMIN, { excludeBudget: false, excludeTotals: false })), 'an exact owner category name without the owner\'s exclude flags');
  const stays = (result, label) => ok(cents(result.cur.balanceAfterDeductions) === cents(control.cur.balanceAfterDeductions) && !result.terms?.moneyOutToConfirm && result.cur.moneyOutToConfirm == null,
    label + ': no money-out term, and the remainder is unchanged at 1,632.01', JSON.stringify([result.cur.balanceAfterDeductions, result.terms?.moneyOutToConfirm]));
  // A valid minimum the category protocol accepted (exact category, flags, obligation, identity rule): the card minimum counts it.
  stays(run(leg(CARDMIN), { minimumOwner: true }), 'a minimum payment the category protocol accepted');
  // A minimum payment already owned by a durable sentPayments record (the incumbent owner): the same exact category, owned elsewhere.
  stays(run(leg(CARDMIN), { minimumOwner: true, durableMinimum: true }), 'a minimum payment already owned by a durable sentPayments record');
  // The owner export (Forecast.cardMinimumOwnedDebits, read server-side and carried as a boolean) decides, not the category:
  // an exact name WITH flags that the owner did not accept (no identity rule links it to the obligation) is counted here.
  counts(run(leg(CARDMIN)), 'an exact owner category name the minimum-payment owner did not accept');
}

console.log('\n=== the card-minimum owner export decides (#1149 P1 6893020218; desk 6893166367; lead ruling (B)) ===');
{
  const MIN = 60;
  // A generic provider 'payment' with NO minimum category: only a durable sentPayments record owns it.
  const plain = [{ account: 1001, amount: MIN, kind: 'payment', payee: 'Synthetic card issuer', date: '2026-08-18' }];
  const control = run([]);
  const owned = run(plain, { durableMinimum: true });
  ok(cents(owned.cur.balanceAfterDeductions) === cents(control.cur.balanceAfterDeductions) && !owned.terms?.moneyOutToConfirm
    && owned.cur.moneyOutToConfirm == null,
    'P1: a debit owned by a durable sentPayments record with no category stamp is not also money out (the remainder stays 1,632.01)',
    JSON.stringify([owned.cur.balanceAfterDeductions, owned.terms?.moneyOutToConfirm]));
  const notOwned = run(plain);
  ok(cents(notOwned.cur.balanceAfterDeductions) === cents(control.cur.balanceAfterDeductions - MIN) && notOwned.terms?.moneyOutToConfirm === MIN,
    'control: the same debit with no owner record counts once, as Money out, to confirm', JSON.stringify(notOwned.terms));
  const other = 'f'.repeat(64);
  const withdrawn = run(plain, { durableMinimum: { debitId: other, movementIdentity: { source: 'lunchmoney-minimum-category', debitId: other } } });
  ok(cents(withdrawn.cur.balanceAfterDeductions) === cents(control.cur.balanceAfterDeductions - MIN) && withdrawn.terms?.moneyOutToConfirm === MIN,
    'an owner record naming another debit does not own this one: it counts once, as Money out', JSON.stringify(withdrawn.terms));
  const unreadable = run(plain, { durableMinimum: { intent: undefined } });
  ok(unreadable.cur.balanceAfterDeductions == null && unreadable.cur.moneyOutToConfirm?.unavailable === true
    && unreadable.cur.moneyOutToConfirm.posted == null && unreadable.cur.balanceAfterDeductionsTrust === 'unavailable',
    'an unreadable owner record: the term reads Unavailable and the remainder is not computed (never a guess)',
    JSON.stringify([unreadable.cur.balanceAfterDeductions, unreadable.cur.moneyOutToConfirm, unreadable.cur.balanceAfterDeductionsTrust]));
  ok(unreadable.cur.plannedPeriodClose == null, 'the planned close is not computed either', String(unreadable.cur.plannedPeriodClose));
  // With no candidate debit the money-out term has nothing to withhold. (The incumbent card-minimum owner
  // already withholds the remainder itself for an unreadable record, as on main; that is its rule, not this term's.)
  const quiet = run([], { durableMinimum: { intent: undefined } });
  ok(quiet.cur.moneyOutToConfirm == null && !Object.hasOwn(quiet.terms || {}, 'moneyOutToConfirm'),
    'an unreadable owner record with no candidate debit adds no money-out term', JSON.stringify(quiet.cur.moneyOutToConfirm));
  // No debit identity reaches the served packet: only the boolean and the export status.
  const served = world(plain, { durableMinimum: true });
  const packet = served.liveOverlay && served.liveOverlay.currentPeriodActuals;
  const blob = JSON.stringify(packet);
  const hash = require('node:crypto').createHash('sha256').update('lunchmoney-minimum-category:94001').digest('hex');
  ok(packet && packet.cardMinimumOwnership === 'available' && packet.transactions.some(tx => tx.cardMinimumOwned === true),
    'the packet carries the export status and the boolean on the owned row');
  ok(!blob.includes(hash) && !/"debitId"/.test(blob) && !/[a-f0-9]{64}/.test(blob),
    'the packet carries no debit identity or 64-hex hash');
}

console.log('\n=== Grok Bot on #1149 (Plan #6, 2026-11-17): single-card categories, disagreements To confirm, Unavailable only when unreadable ===');
{
  const MIN = 60, CARDMIN = 'Minimum payment - TD Travel Visa';
  const Category = require('../scripts/card-minimum-category.js');
  const names = Object.keys(Category.CATEGORIES);
  ok(names.length > 0 && names.every(name => typeof Category.CATEGORIES[name] === 'string' && Category.CATEGORIES[name])
    && Object.isFrozen(Category.CATEGORIES),
    '(1) every minimum category names exactly one card, and the mapping cannot be widened at run time');
  const control = run([]);
  const leg = [{ account: 1001, amount: MIN, kind: 'payment', payee: 'Synthetic card issuer', date: '2026-08-18', categoryName: CARDMIN }];
  // (2) The owner record says this debit paid the Sep 22 occurrence; the ledger's category links it to Aug 22.
  const disagree = run(leg, { minimumOwner: true, durableMinimum: { scheduledDate: '2026-09-22' } });
  ok(cents(disagree.cur.balanceAfterDeductions) === cents(control.cur.balanceAfterDeductions - MIN)
    && disagree.terms?.moneyOutToConfirm === MIN && disagree.cur.moneyOutToConfirm?.disagreement === MIN
    && disagree.cur.moneyOutToConfirm?.unavailable !== true,
    '(2) owner record and ledger link disagree: the 60 counts once as Money out, to confirm, named as a disagreement, not Unavailable',
    JSON.stringify([disagree.cur.balanceAfterDeductions, disagree.cur.moneyOutToConfirm]));
  ok(/Owner record and ledger link disagree \(card or occurrence\): \$60\.00/.test(text(disagree.html)),
    '(2) the page names it: "Owner record and ledger link disagree (card or occurrence)"');
  const F2 = require('../public/forecast');
  const disagreeData = world(leg, { minimumOwner: true, durableMinimum: { scheduledDate: '2026-09-22' } });
  ok(F2.cardMinimumState(disagreeData.plan, '2026-08-20').payments.length === 0, '(2) neither minimum is marked sent');
  // Agreement: the same debit and occurrence in both, the owner record wins and nothing is money out.
  const agree = run(leg, { minimumOwner: true, durableMinimum: true });
  ok(cents(agree.cur.balanceAfterDeductions) === cents(control.cur.balanceAfterDeductions) && agree.cur.moneyOutToConfirm == null,
    '(2) same debit and occurrence: the owner record wins, nothing is money out', JSON.stringify(agree.cur.moneyOutToConfirm));
  // (3) An unreadable owner record is named on the page, and the term is never summed as 0.
  const plain = [{ account: 1001, amount: MIN, kind: 'payment', payee: 'Synthetic card issuer', date: '2026-08-18' }];
  const unreadable = run(plain, { durableMinimum: { intent: undefined } });
  ok(unreadable.cur.moneyOutToConfirm?.unavailable === true && unreadable.cur.moneyOutToConfirm.posted == null
    && /Money out, to confirm: unavailable\. Could not read .+ \(purpose\)\./.test(text(unreadable.html)),
    '(3) Unavailable names the record and what could not be read; never 0', text(unreadable.html).match(/Money out, to confirm: unavailable[^.]*\.[^.]*\./)?.[0]);
}

console.log('\n=== the planned close and every dependent figure read estimated while a money-out term stands ===');
{
  // Every input of this household is confirmed here, so nothing else can make a figure an estimate.
  const calmControl = run([], { confirmed: true });
  const calm = run([transfer], { confirmed: true });
  ok(calmControl.cur.plannedPeriodCloseTrust === 'calculated' && calmControl.cur.balanceAfterDeductionsTrust !== 'estimated',
    'control: with every input confirmed and no money-out term the close and the remainder are not estimates',
    calmControl.cur.plannedPeriodCloseTrust + ' / ' + calmControl.cur.balanceAfterDeductionsTrust);
  ok(calm.cur.balanceAfterDeductionsTrust === 'estimated', 'with the 400 the remainder reads estimated');
  ok(calm.cur.plannedPeriodCloseTrust === 'estimated' && calm.cur.plannedPeriodCloseTerms?.moneyOutToConfirm === DEBIT,
    'the planned close, which holds the same 400, reads estimated too', calm.cur.plannedPeriodCloseTrust);
  ok(cents(calm.cur.plannedPeriodClose) === cents(calmControl.cur.plannedPeriodClose),
    'the close amount is unchanged (the 400 already left the opening, and the term takes it out of the plan once)');
}

console.log('\n=== proven flows are not money out ===');
{
  // A proven move between two household accounts: both TD transfer legs with one reference.
  const moved = run([
    { account: 1002, category: 'transfer', amount: DEBIT, original: 'AB123 TFR-TO INVENTED SAVINGS', payee: 'Transfer out' },
    { account: 1001, category: 'transfer', amount: -DEBIT, original: 'AB123 TFR-FR INVENTED OPERATING', payee: 'Transfer in' },
  ]);
  ok(cents(moved.cur.balanceAfterDeductions) === cents(BEFORE) && !moved.terms?.moneyOutToConfirm && !moved.cur.moneyOutToConfirm,
    'a proven transfer pair (same reference, two household accounts) is not money out', String(moved.cur.balanceAfterDeductions));
  // A TD card payment by its recipient identity counts on the card side, once.
  const card = run([{ category: 'transfer', amount: DEBIT, original: 'AB124 TFR-TO C/C', payee: 'Card payment' }]);
  ok(cents(card.cur.balanceAfterDeductions) === cents(BEFORE) && !card.terms?.moneyOutToConfirm && !card.cur.moneyOutToConfirm,
    'a card payment by identity is not counted again as money out', String(card.cur.balanceAfterDeductions));
}

if (failures) { console.log(`\n${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('\nALL CHECKS PASSED');
