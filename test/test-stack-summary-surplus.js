'use strict';
/* Stack Wallet A2: each pay period publishes "Surplus after deductions"
 * (owner decision, Dale, #821 7013976545, waterfall option 3).
 *
 * Forecast.recommend sets payPeriodViews[i].stackSummary.surplus, read only
 * from that period's final published figures:
 *   amount = incomeTotal − periodBillLoad − budgetHold − savings-item spending
 * with its terms, the trust of Balance After Deductions (the same terms) and
 * projected (next and future periods). The held (To confirm) outflows and
 * manual card payments beyond the minimum are NOT subtracted, so wherever
 * both are published, surplus = Balance After Deductions + held + beyond.
 * Withheld (amount null, trust unavailable, a reason) whenever a term is.
 *
 *   1. hand-derived invented worlds (test/acceptance/harness.js): pay 1,400
 *      on Oct 9, Groceries 300 + Eating out 100 (hold 400), no bills, as of
 *      Oct 14:
 *        control                 surplus 1,000 = BAD 1,000;
 *        a held 400 debit        BAD 600, surplus 1,000 = BAD + held;
 *        a linked 200 item       BAD 800, surplus 800 (item spending counts);
 *        held 400 and item 200   BAD 400, surplus 800;
 *        next and future periods surplus 1,000, projected;
 *        a 60 manual card payment against a 25 minimum (card-coverage
 *        aggregate world: income 1,000, bills 25, groceries 150): BAD 790,
 *        surplus 825 = BAD + the 35 beyond the minimum;
 *        an unusable income override: income withheld, so the surplus is
 *        null, trust unavailable, with a reason, on every period;
 *   2. on every period of the 60 invented figures evaluations and the
 *      753-transaction world: surplus = BAD + held + beyond whenever both are
 *      published, null exactly when a term it sums is, and its trust is BAD's;
 *   3. every existing field is byte-equal: a copy without the new pass gives
 *      the same advice once stackSummary is removed;
 *   4. mutants are caught: subtracting the held term, dropping the item term,
 *      ignoring a withheld term, a fixed 'calculated' trust, and projected
 *      read from the wrong field.
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
const AMOUNT = '      amount: roundCent(view.incomeTotal - view.periodBillLoad - view.budgetHold - item),';
const copies = {
  shipped: require('../public/forecast.js'),
  without: compile(replaceOnce(SOURCE, 'return publishStackSummary(recommend(plan, asOf, opts), plan, asOf, opts);', 'return recommend(plan, asOf, opts);', 'pass off'), 'without'),
  subtractsHeld: compile(replaceOnce(SOURCE, AMOUNT, AMOUNT.replace(' - item),',
    ' - item - ((view.heldOutflowsToConfirm && view.heldOutflowsToConfirm.total) || 0)),'), 'subtracts held'), 'subtracts-held'),
  noItem: compile(replaceOnce(SOURCE, AMOUNT, AMOUNT.replace(' - item),', '),'), 'no item'), 'no-item'),
  ignoresWithheld: compile(replaceOnce(SOURCE, '    if (!known) {\n      return { amount: null,', '    if (false) {\n      return { amount: null,', 'ignores withheld'), 'ignores-withheld'),
  fixedTrust: compile(replaceOnce(SOURCE, "      trust: view.balanceAfterDeductionsTrust || 'calculated',", "      trust: 'calculated',", 'fixed trust'), 'fixed-trust'),
  projectedFromRole: compile(replaceOnce(SOURCE, "    const projected = view.evidenceState === 'projected';", "    const projected = view.timelineRole === 'future';", 'projected role'), 'projected-role'),
};

// 1. The invented harness world.
const MORTGAGE = 116;
function world({ held = false, item = false } = {}) {
  const w = H.baseWorld();
  w.categories.push({ id: MORTGAGE, name: 'Mortgage' });
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
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
    ok(s && s.amount === want.surplus && s.projected === false && s.trust === 'calculated' && s.reason === null,
      `${label}: surplus ${want.surplus} (1,400 − 0 − 400${want.item ? ' − 200' : ''}), not projected, calculated`, JSON.stringify(s));
    ok(s && s.terms && s.terms.income === 1400 && s.terms.bills === 0 && s.terms.household === 400
      && (want.item ? s.terms.savingsItemSpending === 200 : !('savingsItemSpending' in s.terms)),
      `${label}: the terms are income 1,400, bills 0, household 400${want.item ? ', item 200' : ''}`, JSON.stringify(s && s.terms));
    ok(s && s.amount === cur.balanceAfterDeductions + want.held, `${label}: surplus = BAD + held (${want.bad} + ${want.held})`);
  }
  const vs = views(copies.shipped, harnessArgs({ held: true }));
  for (const start of ['2026-10-23', '2026-11-06']) {
    const v = byStart(vs, start), s = surplusOf(v);
    ok(v && v.evidenceState === 'projected' && s && s.amount === 1000 && s.projected === true && s.amount === v.balanceAfterDeductions,
      `the projected period from ${start}: surplus 1,000 = BAD, projected`, JSON.stringify(s));
  }
  // A manual card payment beyond the minimum (test/fixtures/card-coverage-aggregate-world):
  // income 1,000, the 25 card minimum (the only bill), groceries 150, and a 60
  // MBNA payment, 35 beyond the minimum. BAD 1,000 − 25 − 150 − 35 = 790;
  // the surplus does not subtract the 35: 1,000 − 25 − 150 = 825 = BAD + 35.
  {
    const Card = require('./fixtures/card-coverage-aggregate-world');
    const r = Card.run(Card.world([['bills', 60, null, 'cash', { payee: 'MBNA M/C', category_name: 'DEBT&PAYMENTS' }]],
      { card: 'mbna', payDownOnly: ['mbna', 'triangle'] }));
    const s = surplusOf(r.period);
    ok(r.period.balanceAfterDeductions === 790 && r.period.manualCardPaymentsBeyondMinimum
      && r.period.manualCardPaymentsBeyondMinimum.total === 35,
      'a 60 card payment against a 25 minimum: BAD 790 with 35 beyond the minimum', JSON.stringify([r.period.balanceAfterDeductions,
        r.period.manualCardPaymentsBeyondMinimum && r.period.manualCardPaymentsBeyondMinimum.total]));
    ok(s && s.amount === 825 && s.amount === r.period.balanceAfterDeductions + 35
      && s.terms.income === 1000 && s.terms.bills === 25 && s.terms.household === 150,
      'its surplus is 825 (1,000 − 25 − 150) = BAD + the 35 beyond the minimum', JSON.stringify(s));
  }
  const withheld = views(copies.shipped, harnessArgs({}, { incomeOverrides: { payroll: 'not a number' } })).filter(v => v.timelineRole !== 'past');
  ok(withheld.length >= 3 && withheld.every(v => v.incomeTotal === null && surplusOf(v).amount === null && surplusOf(v).terms === null
    && surplusOf(v).trust === 'unavailable' && typeof surplusOf(v).reason === 'string'),
    'an unusable income override withholds income, so every period\'s surplus is null, unavailable, with a reason',
    JSON.stringify(withheld.map(v => surplusOf(v).amount)));
}

// 2. The invented figures evaluations and the 753-transaction world.
const corpus = [];
for (const input of Snap.loadInventedInputs()) {
  for (const shift of [0, 3, 7, 14, 30]) {
    corpus.push(F => {
      const data = structuredClone(input.doc.data);
      return [data.plan, F.addDays(data.meta.asOf, shift),
        Snap.pageOptions(data, input.doc.periods == null ? null : structuredClone(input.doc.periods))];
    });
  }
}
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
function audit(F) {
  const r = { periods: 0, known: 0, withheld: 0, identity: 0, identityFail: 0, nullRule: 0, trustFail: 0, projectedFail: 0, heldOrBeyond: 0 };
  for (const args of corpus) {
    for (const v of F.recommend(...args(F)).payPeriodViews || []) {
      r.periods++;
      const s = surplusOf(v);
      const termsKnown = finite(v.incomeTotal) && finite(v.periodBillLoad) && finite(v.budgetHold) && finite(v.balanceAfterDeductions);
      if (!s || (s.amount === null) === termsKnown) r.nullRule++;
      if (s && s.projected !== (v.evidenceState === 'projected')) r.projectedFail++;
      if (!s || s.amount === null) { r.withheld++; continue; }
      r.known++;
      const held = (v.heldOutflowsToConfirm && finite(v.heldOutflowsToConfirm.total)) ? v.heldOutflowsToConfirm.total : 0;
      const beyond = (v.manualCardPaymentsBeyondMinimum && finite(v.manualCardPaymentsBeyondMinimum.total)) ? v.manualCardPaymentsBeyondMinimum.total : 0;
      if (held || beyond) r.heldOrBeyond++;
      if (Math.abs(s.amount - (v.balanceAfterDeductions + held + beyond)) <= 0.005) r.identity++; else r.identityFail++;
      if (s.trust !== (v.balanceAfterDeductionsTrust || 'calculated')) r.trustFail++;
    }
  }
  return r;
}
console.log('2. Every period of the corpus');
const shippedAudit = audit(copies.shipped);
ok(shippedAudit.periods > 100 && shippedAudit.known > 100 && shippedAudit.identityFail === 0,
  `surplus = BAD + held + beyond on all ${shippedAudit.known} published periods`, JSON.stringify(shippedAudit));
ok(shippedAudit.nullRule === 0, 'surplus is null exactly when income, bills, the hold or BAD is withheld', String(shippedAudit.nullRule));
ok(shippedAudit.trustFail === 0 && shippedAudit.projectedFail === 0, 'its trust is BAD\'s and projected follows the period\'s evidence state',
  JSON.stringify({ trust: shippedAudit.trustFail, projected: shippedAudit.projectedFail }));

console.log('3. Every existing field is byte-equal');
{
  const strip = advice => { for (const v of advice.payPeriodViews || []) delete v.stackSummary; return JSON.stringify(advice); };
  let same = 0, total = 0;
  const all = corpus.concat([harnessArgs({}), harnessArgs({ held: true }), harnessArgs({ item: true }),
    harnessArgs({}, { incomeOverrides: { payroll: 'not a number' } })]);
  for (const args of all) {
    total++;
    const a = strip(copies.shipped.recommend(...args(copies.shipped)));
    const b = JSON.stringify(copies.without.recommend(...args(copies.without)));
    if (a === b) same++;
  }
  ok(same === total, `the advice without stackSummary is byte-equal to the incumbent on all ${total} cases`, `${same} of ${total}`);
}

console.log('4. Mutants are caught');
const handHeld = F => surplusOf(byStart(views(F, harnessArgs({ held: true })), '2026-10-09'));
const handItem = F => surplusOf(byStart(views(F, harnessArgs({ item: true })), '2026-10-09'));
const handWithheld = F => surplusOf(byStart(views(F, harnessArgs({}, { incomeOverrides: { payroll: 'not a number' } })), '2026-10-09'));
ok(handHeld(copies.subtractsHeld).amount !== 1000, 'subtracting the held term is caught (the held world reads 600)', String(handHeld(copies.subtractsHeld).amount));
ok(handItem(copies.noItem).amount !== 800, 'dropping the item term is caught (the item world reads 1,000)', String(handItem(copies.noItem).amount));
ok(handWithheld(copies.ignoresWithheld).amount !== null, 'ignoring a withheld term is caught (a figure is published without income)',
  String(handWithheld(copies.ignoresWithheld).amount));
{
  const a = audit(copies.fixedTrust);
  ok(a.trustFail > 0, 'a fixed calculated trust is caught where BAD is estimated or unavailable', String(a.trustFail));
  const p = audit(copies.projectedFromRole);
  ok(p.projectedFail > 0, 'projected read from the timeline role is caught (the next period is projected too)', String(p.projectedFail));
}

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} stack surplus checks passed`);
process.exit(failures ? 1 : 0);
