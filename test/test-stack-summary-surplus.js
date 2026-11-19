'use strict';
/* Stack Wallet A2: each pay period publishes its bills split and "Surplus
 * after deductions" (owner decision, Dale, #821 7013976545, waterfall option
 * 3, reshaped by Dale to Income − Bills − Budget − Mortgage − Credit; lead
 * restatement 2026-11-19: Credit is the card minimums only).
 *
 * Forecast.recommend sets, on payPeriodViews[i].stackSummary:
 *   bills   = { mortgage, cardMinimums: [{ debtId, amount }], other, trust }:
 *             the period's periodBillLoad split over the same rows and amount
 *             (mortgage obligations, revolving-card minimum payments, the
 *             rest), summing to it to the cent, null exactly where it is null;
 *   surplus = income − other bills − Household hold − mortgage − Σ card
 *             minimums − savings-item spending, with its terms, the trust of
 *             Balance After Deductions and projected. Held (To confirm)
 *             outflows and card payments beyond the minimum are NOT
 *             subtracted, so wherever both are published,
 *             surplus = Balance After Deductions + held + beyond.
 *
 *   1. hand-derived invented worlds (test/acceptance/harness.js): pay 1,400
 *      on Oct 9, Groceries 300 + Eating out 100 (hold 400), as of Oct 14:
 *        control, held 400, item 200, held + item (no bills): surplus
 *        1,000 / 1,000 / 800 / 800 = BAD + held;
 *        bills: hydro 90 (12th), a card-paid streaming bill 20 (14th),
 *        mortgage 300 (16th), card minimums 25 (mbna, 15th) and 10
 *        (triangle, 20th), a non-cash card item 7: load 445 = mortgage 300 +
 *        credit 35 + other 110; surplus 1,400 − 110 − 400 − 300 − 35 = 555;
 *        an unknown hydro amount: load, split and surplus withheld;
 *        the card-coverage aggregate world: the 25 minimum is credit whether
 *        unpaid, pending or paid by a 60 payment (BAD 790, surplus 825);
 *        an unusable income override: every surplus null with a reason;
 *   2. the split itself, called directly: a scheduled-fee allowance and a
 *      bill stay in other, a covered minimum keeps its full amount, and the
 *      publication withholds a split that no longer sums to its total;
 *   3. every period of the 60 invented figures evaluations, the same 12
 *      inputs with an invented mortgage and two card minimums, and the
 *      753-transaction world: the split sums to the load, the surplus terms
 *      are the split, surplus = BAD + held + beyond, null rules and trust;
 *   4. every existing field is byte-equal without stackSummary;
 *   5. mutants are caught.
 *
 * Invented data only. `node test/test-stack-summary-surplus.js`
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const H = require('./acceptance/harness.js');
const Snap = require('../scripts/figures-snapshot.js');

let failures = 0, checks = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? ' — ' + detail : ''}`);
};

const FILE = path.join(__dirname, '..', 'public', 'forecast.js');
const SOURCE = fs.readFileSync(FILE, 'utf8');
const replaceOnce = (text, from, to, label) => {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error('anchor not found exactly once: ' + label);
  return parts.join(to);
};
function compile(text, name) {
  const mod = new Module(FILE, module);
  mod.filename = FILE;
  mod.paths = Module._nodeModulePaths(path.dirname(FILE));
  mod._compile(text, FILE.replace(/\.js$/, '-' + name + '.js'));
  return mod.exports;
}
const CENTS = "      - stackCents(mortgage) - creditCents - stackCents(item);";
const MORTGAGE_IDS = "    const mortgageIds = new Set(obligations.filter(o => o.debtId === 'mortgage' || o.id === 'mortgage').map(o => String(o.id)));";
const CARD_OF = "      && isRevolvingCardAccount({ account: o.debtId })).map(o => [String(o.id), String(o.debtId)]));";
const OTHER = '      other: (totalCents - mortgageCents - minimumsCents) / 100,';
const EXPORT = "  if (typeof module !== 'undefined' && module.exports) module.exports = Forecast;";
const copies = {
  shipped: require('../public/forecast.js'),
  exposed: compile(replaceOnce(SOURCE, EXPORT, '  Forecast.__stack = { periodAssignedBillParts, stackBills, periodBillLoadPartsByPeriod };\n' + EXPORT, 'expose'), 'exposed'),
  without: compile(replaceOnce(SOURCE, 'return publishStackSummary(recommend(plan, asOf, opts), plan, asOf, opts);', 'return recommend(plan, asOf, opts);', 'pass off'), 'without'),
  subtractsHeld: compile(replaceOnce(SOURCE, CENTS, CENTS.replace(';', ' - stackCents((view.heldOutflowsToConfirm && view.heldOutflowsToConfirm.total) || 0);'), 'subtracts held'), 'subtracts-held'),
  noItem: compile(replaceOnce(SOURCE, CENTS, CENTS.replace(' - stackCents(item);', ';'), 'no item'), 'no-item'),
  noCredit: compile(replaceOnce(SOURCE, CENTS, CENTS.replace(' - creditCents', ''), 'no credit'), 'no-credit'),
  noMortgageTerm: compile(replaceOnce(SOURCE, CENTS, CENTS.replace('      - stackCents(mortgage)', '     '), 'no mortgage term'), 'no-mortgage-term'),
  mortgageInOther: compile(replaceOnce(SOURCE, MORTGAGE_IDS, '    const mortgageIds = new Set();', 'mortgage in other'), 'mortgage-in-other'),
  minimumsInOther: compile(replaceOnce(SOURCE, CARD_OF, CARD_OF.replace('isRevolvingCardAccount({ account: o.debtId })', 'false'), 'minimums in other'), 'minimums-in-other'),
  otherIsTotal: compile(replaceOnce(SOURCE, OTHER, '      other: totalCents / 100,', 'other is total'), 'other-is-total'),
  ignoresWithheld: compile(replaceOnce(SOURCE, '    if (!known) {\n      return { amount: null,', '    if (false) {\n      return { amount: null,', 'ignores withheld'), 'ignores-withheld'),
  fixedTrust: compile(replaceOnce(SOURCE, "      trust: view.balanceAfterDeductionsTrust || 'calculated',", "      trust: 'calculated',", 'fixed trust'), 'fixed-trust'),
  projectedFromRole: compile(replaceOnce(SOURCE, "    const projected = view.evidenceState === 'projected';", "    const projected = view.timelineRole === 'future';", 'projected role'), 'projected-role'),
};

// 1. The invented harness world.
const MORTGAGE = 116;
const OBLIGATIONS = [
  { id: 'inv-mortgage', label: 'Invented mortgage', debtId: 'mortgage', effect: 'payment', frequency: 'monthly', day: 16, amount: 300,
    confidence: 'confirmed', payingAccount: 'chequing-a' },
  { id: 'inv-card-a', label: 'Invented card A minimum', debtId: 'mbna', effect: 'payment', frequency: 'monthly', day: 15, amount: 25,
    confidence: 'confirmed', payingAccount: 'chequing-a' },
  { id: 'inv-card-b', label: 'Invented card B minimum', debtId: 'triangle', effect: 'payment', frequency: 'monthly', day: 20, amount: 10,
    confidence: 'confirmed', payingAccount: 'chequing-a' },
  { id: 'inv-noncash', label: 'Invented non-cash card item', debtId: 'cashback', effect: 'payment', frequency: 'monthly', day: 17, amount: 7,
    nonCash: true, confidence: 'confirmed' },
];
function world({ held = false, item = false, bills = false, hydro = 90 } = {}) {
  const w = H.baseWorld();
  w.categories.push({ id: MORTGAGE, name: 'Mortgage' });
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  if (bills) {
    w.bills = [{ id: 'hydro', label: 'Invented hydro', amount: hydro, frequency: 'monthly', day: 12, confidence: 'confirmed' },
      { id: 'stream', label: 'Invented streaming', amount: 20, frequency: 'monthly', day: 14, confidence: 'confirmed',
        jointCash: false, payingAccount: 'mbna' }];
    w.obligations = structuredClone(OBLIGATIONS);
  }
  if (held) w.transactions.push(H.lm({ date: '2026-10-12', amount: 400, category: MORTGAGE, account: 'chequing-a', payee: 'Invented lender' }));
  if (item) {
    w.commitments = [{ id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: 'confirmed', sinkingFund: true }];
    w.savingsPool = { value: 1000 };
    w.links = [{ categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-11-20',
      effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' }];
    w.transactions.push(H.lm({ date: '2026-10-12', amount: 200, category: 106, account: 'chequing-a', payee: 'Invented outfitter' }));
  }
  return w;
}
function harnessArgs(spec, extra = {}) {
  const w = world(spec);
  const { data, packet, error } = H.dataOf(w);
  if (error) throw error;
  return () => [structuredClone(data.plan), w.asOf, Object.assign({ debts: structuredClone(data.debts), currentPeriodActuals: structuredClone(packet) }, extra)];
}
const views = (F, args) => F.recommend(...args()).payPeriodViews;
const byStart = (vs, start) => vs.find(v => v.start === start);
const surplusOf = v => v && v.stackSummary && v.stackSummary.surplus;
const billsOf = v => v && v.stackSummary && v.stackSummary.bills;
const NO_BILLS = { mortgage: 0, cardMinimums: [], other: 0, trust: 'calculated' };

console.log('1. Hand-derived invented worlds');
{
  const cases = [
    ['control', {}, { bad: 1000, surplus: 1000, item: 0, held: 0 }],
    ['a held 400 debit', { held: true }, { bad: 600, surplus: 1000, item: 0, held: 400 }],
    ['a linked 200 item', { item: true }, { bad: 800, surplus: 800, item: 200, held: 0 }],
    ['a held 400 debit and a linked 200 item', { held: true, item: true }, { bad: 400, surplus: 800, item: 200, held: 400 }],
  ];
  for (const [label, spec, want] of cases) {
    const vs = views(copies.shipped, harnessArgs(spec));
    const cur = byStart(vs, '2026-10-09'), s = surplusOf(cur);
    ok(cur && cur.incomeTotal === 1400 && cur.periodBillLoad === 0 && cur.budgetHold === 400 && cur.balanceAfterDeductions === want.bad,
      `${label}: the published BAD is the hand figure ${want.bad}`, JSON.stringify(cur && [cur.incomeTotal, cur.periodBillLoad, cur.budgetHold, cur.balanceAfterDeductions]));
    ok(s && s.amount === want.surplus && s.projected === false && s.trust === 'calculated' && !('reason' in s),
      `${label}: surplus ${want.surplus} (1,400 − 0 − 400${want.item ? ' − 200' : ''}), not projected, calculated`, JSON.stringify(s));
    ok(s && s.terms && s.terms.income === 1400 && s.terms.bills === 0 && s.terms.mortgage === 0 && s.terms.credit === 0 && s.terms.household === 400
      && (want.item ? s.terms.savingsItemSpending === 200 : !('savingsItemSpending' in s.terms))
      && JSON.stringify(billsOf(cur)) === JSON.stringify(NO_BILLS),
      `${label}: the terms are income 1,400, bills 0, mortgage 0, credit 0, household 400${want.item ? ', item 200' : ''}`, JSON.stringify(s && s.terms));
    ok(s && s.amount === cur.balanceAfterDeductions + want.held, `${label}: surplus = BAD + held (${want.bad} + ${want.held})`);
  }
  const vs = views(copies.shipped, harnessArgs({ held: true }));
  for (const start of ['2026-10-23', '2026-11-06']) {
    const v = byStart(vs, start), s = surplusOf(v);
    ok(v && v.evidenceState === 'projected' && s && s.amount === 1000 && s.projected === true && s.amount === v.balanceAfterDeductions,
      `the projected period from ${start}: surplus 1,000 = BAD, projected`, JSON.stringify(s));
  }
  // Bills, a mortgage and two card minimums in the Oct 9 – Oct 22 period:
  // hydro 90 + card-paid streaming 20 = other 110; mortgage 300; minimums
  // mbna 25 + triangle 10 = credit 35; the non-cash item is in no bill.
  // Load 445 = 110 + 300 + 35. BAD 1,400 − 445 − 400 = 555 = the surplus
  // 1,400 − 110 − 400 − 300 − 35 (no held, no beyond).
  {
    const cur = byStart(views(copies.shipped, harnessArgs({ bills: true })), '2026-10-09'), b = billsOf(cur), s = surplusOf(cur);
    ok(cur && cur.periodBillLoad === 445 && cur.balanceAfterDeductions === 555, 'bills world: the published load is 445 and BAD 555',
      JSON.stringify(cur && [cur.periodBillLoad, cur.balanceAfterDeductions]));
    ok(JSON.stringify(b) === JSON.stringify({ mortgage: 300, cardMinimums: [{ debtId: 'mbna', amount: 25 }, { debtId: 'triangle', amount: 10 }],
      other: 110, trust: 'calculated' }), 'its split: mortgage 300, minimums mbna 25 + triangle 10, other 110 (card-paid bill included), no non-cash item',
      JSON.stringify(b));
    ok(s && s.amount === 555 && JSON.stringify(s.terms) === JSON.stringify({ income: 1400, bills: 110, household: 400, mortgage: 300, credit: 35 }),
      'its surplus is 555 = 1,400 − 110 − 400 − 300 − 35', JSON.stringify(s));
    const next = byStart(views(copies.shipped, harnessArgs({ bills: true })), '2026-11-06');
    ok(next && billsOf(next).mortgage === 300 && JSON.stringify(billsOf(next).cardMinimums) === JSON.stringify([{ debtId: 'mbna', amount: 25 }])
      && billsOf(next).other === 110 && surplusOf(next).amount === 565 && surplusOf(next).projected === true,
      'the projected Nov 6 period: mortgage 300, mbna 25, other 110 (hydro 90 + streaming 20), surplus 565, projected', JSON.stringify(next && next.stackSummary));
    const unknown = byStart(views(copies.shipped, harnessArgs({ bills: true, hydro: null })), '2026-10-09');
    ok(unknown && unknown.periodBillLoad === null && billsOf(unknown).mortgage === null && billsOf(unknown).cardMinimums === null
      && billsOf(unknown).other === null && billsOf(unknown).trust === 'unavailable' && typeof billsOf(unknown).reason === 'string'
      && surplusOf(unknown).amount === null,
      'an unknown hydro amount withholds the load, so every part and the surplus are null, unavailable, with a reason',
      JSON.stringify(unknown && unknown.stackSummary));
  }
  // A manual card payment beyond the minimum (test/fixtures/card-coverage-aggregate-world):
  // income 1,000, the 25 card minimum (the only bill), groceries 150. The
  // minimum is credit, at its full 25, whether unpaid, pending, or paid by a
  // 60 payment (35 beyond it). BAD 1,000 − 25 − 150 − 35 = 790; the surplus
  // does not subtract the 35: 1,000 − 0 − 150 − 0 − 25 = 825 = BAD + 35.
  {
    const Card = require('./fixtures/card-coverage-aggregate-world');
    const pay = extra => ['bills', 60, null, 'cash', Object.assign({ payee: 'MBNA M/C', category_name: 'DEBT&PAYMENTS' }, extra)];
    const run = rows => Card.run(Card.world(rows, { card: 'mbna', payDownOnly: ['mbna', 'triangle'] })).period;
    const paid = run([pay()]), s = surplusOf(paid);
    ok(paid.balanceAfterDeductions === 790 && paid.manualCardPaymentsBeyondMinimum
      && paid.manualCardPaymentsBeyondMinimum.total === 35,
      'a 60 card payment against a 25 minimum: BAD 790 with 35 beyond the minimum', JSON.stringify([paid.balanceAfterDeductions,
        paid.manualCardPaymentsBeyondMinimum && paid.manualCardPaymentsBeyondMinimum.total]));
    ok(s && s.amount === 825 && s.amount === paid.balanceAfterDeductions + 35
      && JSON.stringify(s.terms) === JSON.stringify({ income: 1000, bills: 0, household: 150, mortgage: 0, credit: 25 }),
      'its surplus is 825 (1,000 − 0 − 150 − 0 − 25) = BAD + the 35 beyond the minimum', JSON.stringify(s));
    const minimum = JSON.stringify({ mortgage: 0, cardMinimums: [{ debtId: 'mbna', amount: 25 }], other: 0, trust: 'calculated' });
    const pending = run([['bills', 25, null, 'cash', { payee: 'MBNA M/C', category_name: 'DEBT&PAYMENTS', is_pending: true, status: 'pending' }]]);
    const unpaid = run([]);
    ok(paid.bills.some(row => row.id === 'mbna-minimum' && row.status === 'PAID') && [paid, pending, unpaid].every(p => JSON.stringify(billsOf(p)) === minimum)
      && surplusOf(pending).amount === 825 && surplusOf(unpaid).amount === 825,
      'the 25 minimum is credit at its full amount when paid, pending or unpaid', JSON.stringify([paid, pending, unpaid].map(billsOf)));
  }
  const withheld = views(copies.shipped, harnessArgs({}, { incomeOverrides: { payroll: 'not a number' } })).filter(v => v.timelineRole !== 'past');
  ok(withheld.length >= 3 && withheld.every(v => v.incomeTotal === null && surplusOf(v).amount === null && surplusOf(v).terms === null
    && surplusOf(v).trust === 'unavailable' && typeof surplusOf(v).reason === 'string' && billsOf(v).other === 0),
    'an unusable income override withholds income, so every period\'s surplus is null, unavailable, with a reason (its bills split stays)',
    JSON.stringify(withheld.map(v => surplusOf(v).amount)));
}

console.log('2. The split, called directly');
{
  const S = copies.exposed.__stack;
  const plan = { obligations: OBLIGATIONS };
  const rows = [
    { id: 'tdfees', kind: 'bill', planned: 5, amount: 5, scheduledFeeAllowance: { periodCost: 8 } },
    { id: 'inv-card-a', kind: 'obligation', planned: 25, amount: 25, status: 'PAID', actual: 25, remaining: 0 },
    { id: 'inv-mortgage', kind: 'obligation', planned: 300, amount: 300 },
    { id: 'inv-mortgage', kind: 'bill', planned: 40, amount: 40 },
    { id: 'inv-card-b', kind: 'obligation', planned: 10, amount: 10, needsDate: true },
  ];
  const parts = S.periodAssignedBillParts(rows, null, plan, 373);
  ok(JSON.stringify(parts) === JSON.stringify({ mortgage: 300, cardMinimums: [{ debtId: 'mbna', amount: 25 }], other: 48 }),
    'a fee allowance (its 8 period cost) and a bill sharing an obligation id stay in other; a paid minimum keeps 25; an undated row is in no part',
    JSON.stringify(parts));
  ok(S.periodAssignedBillParts(rows, null, plan, null) === null, 'no total, no split');
  const view = { periodBillLoad: 373, periodBillLoadTrust: 'estimated' };
  S.periodBillLoadPartsByPeriod.set(view, parts);
  ok(S.stackBills(view).other === 48 && S.stackBills(view).trust === 'estimated', 'the publication carries the split with the bill total\'s trust');
  view.periodBillLoad = null;
  ok(S.stackBills(view).other === null, 'a total withheld after the waterfall withholds its split');
  view.periodBillLoad = 374;
  ok(S.stackBills(view).other === null, 'a split that no longer sums to its total to the cent is withheld');
  view.periodBillLoad = 373; view.operatingPlanUnavailable = true;
  ok(S.stackBills(view).other === null, 'an unavailable operating plan withholds the split');
  ok(S.stackBills({ periodBillLoad: 373 }).other === null, 'a period copy with no recorded split publishes none');
}

// 3. The invented figures evaluations (as shipped, and with the invented
// mortgage and card minimums added) and the 753-transaction world.
const corpus = [];
for (const input of Snap.loadInventedInputs()) {
  for (const shift of [0, 3, 7, 14, 30]) {
    corpus.push(F => {
      const data = structuredClone(input.doc.data);
      return [data.plan, F.addDays(data.meta.asOf, shift),
        Snap.pageOptions(data, input.doc.periods == null ? null : structuredClone(input.doc.periods))];
    });
  }
  corpus.push(F => {
    const data = structuredClone(input.doc.data);
    data.plan.obligations = (data.plan.obligations || []).concat(structuredClone(OBLIGATIONS));
    return [data.plan, data.meta.asOf, Snap.pageOptions(data, input.doc.periods == null ? null : structuredClone(input.doc.periods))];
  });
}
for (const spec of [{ bills: true, held: true }, { held: true }, { held: true, item: true }]) corpus.push(harnessArgs(spec));
{
  const w = H.baseWorld();
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  for (let i = 0; i < 753; i++) {
    const d = H.lm({ date: '2026-' + (i % 2 ? '10' : '09') + '-' + String(1 + (i % 28)).padStart(2, '0'),
      amount: 5 + (i % 37), category: i % 3 ? 'Groceries' : 'Restaurants', account: 'chequing-a', payee: 'Invented merchant ' + (i % 50) });
    if (d.date <= w.asOf) w.transactions.push(d);
  }
  const { data, packet, error } = H.dataOf(w);
  if (error) throw error;
  corpus.push(() => [structuredClone(data.plan), w.asOf, { debts: structuredClone(data.debts), currentPeriodActuals: structuredClone(packet) }]);
}
const finite = v => typeof v === 'number' && Number.isFinite(v);
const cents = v => Math.round(v * 100);
function audit(F) {
  const r = { periods: 0, known: 0, withheld: 0, identity: 0, identityFail: 0, nullRule: 0, trustFail: 0, projectedFail: 0, heldOrBeyond: 0,
    split: 0, splitFail: 0, splitNullRule: 0, withMortgage: 0, withMinimums: 0, termsFail: 0 };
  for (const args of corpus) {
    for (const v of F.recommend(...args(F)).payPeriodViews || []) {
      r.periods++;
      const s = surplusOf(v), b = billsOf(v);
      if (!b || (b.other === null) === finite(v.periodBillLoad)) r.splitNullRule++;
      if (b && b.other !== null) {
        r.split++;
        if (b.mortgage > 0) r.withMortgage++;
        if (b.cardMinimums.length) r.withMinimums++;
        const sum = cents(b.mortgage) + cents(b.other) + b.cardMinimums.reduce((t, c) => t + cents(c.amount), 0);
        if (sum !== cents(v.periodBillLoad) || b.trust !== (v.periodBillLoadTrust || 'calculated')
          || b.cardMinimums.some(c => !(c.amount > 0) || typeof c.debtId !== 'string')) r.splitFail++;
      }
      const termsKnown = finite(v.incomeTotal) && finite(v.periodBillLoad) && finite(v.budgetHold) && finite(v.balanceAfterDeductions);
      if (!s || (s.amount === null) === termsKnown) r.nullRule++;
      if (s && s.projected !== (v.evidenceState === 'projected')) r.projectedFail++;
      if (!s || s.amount === null) { r.withheld++; continue; }
      r.known++;
      if (s.terms.bills !== b.other || s.terms.mortgage !== b.mortgage
        || cents(s.terms.credit) !== b.cardMinimums.reduce((t, c) => t + cents(c.amount), 0)) r.termsFail++;
      const held = (v.heldOutflowsToConfirm && finite(v.heldOutflowsToConfirm.total)) ? v.heldOutflowsToConfirm.total : 0;
      const beyond = (v.manualCardPaymentsBeyondMinimum && finite(v.manualCardPaymentsBeyondMinimum.total)) ? v.manualCardPaymentsBeyondMinimum.total : 0;
      if (held || beyond) r.heldOrBeyond++;
      if (Math.abs(s.amount - (v.balanceAfterDeductions + held + beyond)) <= 0.005) r.identity++; else r.identityFail++;
      if (s.trust !== (v.balanceAfterDeductionsTrust || 'calculated')) r.trustFail++;
    }
  }
  return r;
}
console.log('3. Every period of the corpus');
const shippedAudit = audit(copies.shipped);
ok(shippedAudit.split > 100 && shippedAudit.withMortgage > 20 && shippedAudit.withMinimums > 20 && shippedAudit.splitFail === 0,
  `the split sums to the load to the cent with its trust on all ${shippedAudit.split} split periods (${shippedAudit.withMortgage} with a mortgage, ${shippedAudit.withMinimums} with minimums)`,
  JSON.stringify(shippedAudit));
ok(shippedAudit.splitNullRule === 0, 'the split is null exactly when the load is', String(shippedAudit.splitNullRule));
ok(shippedAudit.periods > 100 && shippedAudit.known > 100 && shippedAudit.identityFail === 0 && shippedAudit.heldOrBeyond > 0,
  `surplus = BAD + held + beyond on all ${shippedAudit.known} published periods`, JSON.stringify(shippedAudit));
ok(shippedAudit.termsFail === 0, 'the surplus\'s bills, mortgage and credit terms are the published split', String(shippedAudit.termsFail));
ok(shippedAudit.nullRule === 0, 'surplus is null exactly when income, bills, the hold or BAD is withheld', String(shippedAudit.nullRule));
ok(shippedAudit.trustFail === 0 && shippedAudit.projectedFail === 0, 'its trust is BAD\'s and projected follows the period\'s evidence state',
  JSON.stringify({ trust: shippedAudit.trustFail, projected: shippedAudit.projectedFail }));

console.log('4. Every existing field is byte-equal');
{
  const strip = advice => { for (const v of advice.payPeriodViews || []) delete v.stackSummary; return JSON.stringify(advice); };
  let same = 0, total = 0;
  const all = corpus.concat([harnessArgs({}), harnessArgs({ held: true }), harnessArgs({ item: true }), harnessArgs({ bills: true, hydro: null }),
    harnessArgs({}, { incomeOverrides: { payroll: 'not a number' } })]);
  for (const args of all) {
    total++;
    const a = strip(copies.shipped.recommend(...args(copies.shipped)));
    const b = JSON.stringify(copies.without.recommend(...args(copies.without)));
    if (a === b) same++;
  }
  ok(same === total, `the advice without stackSummary is byte-equal to the incumbent on all ${total} cases`, `${same} of ${total}`);
}

console.log('5. Mutants are caught');
const hand = (F, spec, extra) => byStart(views(F, harnessArgs(spec, extra)), '2026-10-09');
ok(surplusOf(hand(copies.subtractsHeld, { held: true })).amount !== 1000, 'subtracting the held term is caught (the held world reads 600)');
ok(surplusOf(hand(copies.noItem, { item: true })).amount !== 800, 'dropping the item term is caught (the item world reads 1,000)');
ok(surplusOf(hand(copies.noCredit, { bills: true })).amount !== 555, 'dropping the credit term is caught (the bills world reads 590)');
ok(surplusOf(hand(copies.noMortgageTerm, { bills: true })).amount !== 555, 'dropping the mortgage term is caught (the bills world reads 855)');
ok(billsOf(hand(copies.mortgageInOther, { bills: true })).mortgage !== 300, 'a mortgage counted in other is caught');
ok(billsOf(hand(copies.minimumsInOther, { bills: true })).cardMinimums.length === 0
  && audit(copies.minimumsInOther).withMinimums === 0, 'card minimums counted in other are caught');
ok(billsOf(hand(copies.otherIsTotal, { bills: true })).other === null, 'an other part that double-counts fails the sum and is withheld, never published');
ok(surplusOf(hand(copies.ignoresWithheld, {}, { incomeOverrides: { payroll: 'not a number' } })).amount !== null,
  'ignoring a withheld term is caught (a figure is published without income)');
{
  const a = audit(copies.fixedTrust);
  ok(a.trustFail > 0, 'a fixed calculated trust is caught where BAD is estimated or unavailable', String(a.trustFail));
  const p = audit(copies.projectedFromRole);
  ok(p.projectedFail > 0, 'projected read from the timeline role is caught (the next period is projected too)', String(p.projectedFail));
}

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} stack surplus checks passed`);
process.exit(failures ? 1 : 0);
