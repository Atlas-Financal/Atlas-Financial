'use strict';
/* The income guards check the inflow before the account text, and every
 * answer is unchanged (ATLAS LEAD 11, speed-up 5).
 *
 * isGenuineOtherIncomeTransaction and isExpectedIncomeSettlementCredit
 * (public/forecast.js) rejected a row on the Amanda-tennis account text before
 * checking that it is an inflow at all, so every debit built a six-field
 * account string and ran a regex before being rejected as not an inflow. The
 * inflow check now runs first. Both guards only ever reject (return false), so
 * their order decides which one rejects, never the answer, unless a guard
 * throws. This test holds the change to a copy of the same source with the
 * old order:
 *
 *   1. row by row: every (row, plan, options) the two functions are asked
 *      about on the corpus below, plus invented rows built to reach each
 *      guard (credits and debits on the tennis account and on household cash,
 *      internal transfers, an ATM cash deposit, a refund, flagged income), give
 *      the same answer from both functions in both orders;
 *   2. every row the corpus asks about is plain: each field the reordered
 *      guards read is a string, number, boolean, null or absent. A row whose
 *      account field throws when turned into text is the one case where order
 *      shows (the old order throws, the new one rejects the debit first), and
 *      the test shows exactly that, so the claim rests on rows being plain;
 *   3. identical advice with the old order on all 60 invented figures
 *      evaluations, two held-income worlds and a 753-transaction world;
 *   4. mutants a slip here could make are caught: no inflow guard in the
 *      income test, the settlement inflow guard flipped, and a tennis-account
 *      test that also matches household chequing. Removing the early tennis
 *      guard altogether is not caught, and cannot be: txMatchesScheduledIncome
 *      rejects the same account text before either function can answer true,
 *      so the early guard only rejects sooner. The test shows that too.
 *
 * Invented data only. `node test/test-income-guard-inflow-first.js`
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const Snap = require('../scripts/figures-snapshot.js');
const World = require('./fixtures/held-other-income-search-world');
const H = require('./acceptance/harness.js');

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
const TENNIS = '    if (isTennisIncomeAccount(personalAccountText(tx))) return false;\n';
const INCOME_INFLOW = '    if (!(txInflowAmount(tx) > EPSILON)) return false;\n';
const SETTLE_INFLOW = '    if (!(txInflowAmount(tx) > EPSILON) || isInternalHouseholdTransfer(tx)) return false;\n';
const INCOME_HEAD = '  function isGenuineOtherIncomeTransaction(tx, plan, opts) {';
const SETTLE_HEAD = '  function isExpectedIncomeSettlementCredit(tx, plan, opts) {';
const P = 'globalThis.__atlasGuardProof';
// Every copy exports both functions and records each call's arguments.
const instrumented = text => replaceOnce(replaceOnce(replaceOnce(text,
  INCOME_HEAD, INCOME_HEAD + ` if (${P}) ${P}.asked.push(['income', tx, plan, opts]);`, 'income record'),
  SETTLE_HEAD, SETTLE_HEAD + ` if (${P}) ${P}.asked.push(['settle', tx, plan, opts]);`, 'settle record'),
  '  const Forecast = {', '  const Forecast = { __income: isGenuineOtherIncomeTransaction, __settle: isExpectedIncomeSettlementCredit,', 'export');
const SHIPPED = instrumented(SOURCE);
// The shipped order, checked: the inflow guard comes first in both functions.
ok(SOURCE.includes(INCOME_INFLOW + TENNIS) && SOURCE.includes(SETTLE_INFLOW + TENNIS),
  'shipped order: the inflow guard runs before the tennis-account guard in both functions');
const oldOrder = replaceOnce(replaceOnce(SHIPPED, INCOME_INFLOW + TENNIS, TENNIS + INCOME_INFLOW, 'income old order'),
  SETTLE_INFLOW + TENNIS, TENNIS + SETTLE_INFLOW, 'settle old order');
const inBody = (text, head, from, to, label) => {
  const at = text.indexOf(head);
  const end = text.indexOf('\n  }\n', at);
  const body = text.slice(at, end);
  return text.slice(0, at) + replaceOnce(body, from, to, label) + text.slice(end);
};
const copies = {
  shipped: compile(SHIPPED, 'shipped'),
  reference: compile(oldOrder, 'old-order'),
  // Mutants a slip in this change could make.
  noIncomeInflow: compile(inBody(SHIPPED, INCOME_HEAD, INCOME_INFLOW, '', 'income inflow'), 'no-income-inflow'),
  settleInflowFlipped: compile(inBody(SHIPPED, SETTLE_HEAD, SETTLE_INFLOW,
    SETTLE_INFLOW.replace('!(txInflowAmount(tx) > EPSILON)', '(txInflowAmount(tx) > EPSILON)'), 'settle inflow flipped'), 'settle-flipped'),
  tennisTooWide: compile(replaceOnce(SHIPPED, "return /amanda-debt-payments|tennis\\s*income/i.test(text || '');",
    "return /amanda-debt-payments|tennis\\s*income|chequing/i.test(text || '');", 'tennis too wide'), 'tennis-wide'),
  // Not mutants that can be caught: without the early tennis guard, the later
  // txMatchesScheduledIncome check rejects the same account text before
  // either function can answer true (section 4 shows they are equivalent).
  noIncomeTennis: compile(inBody(SHIPPED, INCOME_HEAD, TENNIS, '', 'income tennis'), 'no-income-tennis'),
  noSettleTennis: compile(inBody(SHIPPED, SETTLE_HEAD, TENNIS, '', 'settle tennis'), 'no-settle-tennis'),
};
ok(new Set(Object.values(copies)).size === Object.keys(copies).length, `${Object.keys(copies).length} independent engine copies`);

// The corpus: each case returns the recommend arguments, freshly cloned.
const cases = [];
for (const input of Snap.loadInventedInputs()) {
  for (const shift of [0, 3, 7, 14, 30]) {
    cases.push({ id: `${input.id} +${shift}`, kind: 'invented', args: F => {
      const data = structuredClone(input.doc.data);
      return [data.plan, F.addDays(data.meta.asOf, shift),
        Snap.pageOptions(data, input.doc.periods == null ? null : structuredClone(input.doc.periods))];
    } });
  }
}
const HELD_AS_OF = '2026-11-10';
for (const [label, world] of [
  ['held world, 120 purchases', { transactions: 120, days: 30, rebate: { date: '2026-11-12', amount: 200 },
    receipts: [{ id: 'gift', date: '2026-11-08', amount: 50 }] }],
  ['held world with the payroll walk', { walk: true, transactions: 120, days: 30, rebate: { date: '2026-11-12', amount: 200 },
    receipts: [{ id: 'gift', date: '2026-11-08', amount: 50 }] }],
]) {
  const data = World.build(Object.assign({ asOf: HELD_AS_OF }, world));
  cases.push({ id: label, kind: 'held', args: () => {
    const d = structuredClone(data);
    return [d.plan, HELD_AS_OF, World.recommendOptions(d)];
  } });
}
{
  // The harness world with 753 invented purchases (567 fall on or before as-of).
  const w = H.baseWorld();
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  for (let i = 0; i < 753; i++) {
    const d = H.lm({ date: '2026-' + (i % 2 ? '10' : '09') + '-' + String(1 + (i % 28)).padStart(2, '0'),
      amount: 5 + (i % 37), category: i % 3 ? 'Groceries' : 'Restaurants', account: 'chequing-a', payee: 'Invented merchant ' + (i % 50) });
    if (d.date <= w.asOf) w.transactions.push(d);
  }
  const { data, packet, error } = H.dataOf(w);
  if (error) throw error;
  cases.push({ id: `harness world, ${w.transactions.length - 1} purchases`, kind: 'large', args: () => {
    const d = structuredClone(data);
    return [d.plan, w.asOf, { debts: d.debts, currentPeriodActuals: structuredClone(packet) }];
  } });
}
function run(F, c, record = false) {
  globalThis.__atlasGuardProof = record ? { asked: [] } : null;
  let json;
  try { json = JSON.stringify(F.recommend(...c.args(F))); } catch (err) { json = 'error: ' + (err && err.message); }
  const asked = record ? globalThis.__atlasGuardProof.asked : [];
  globalThis.__atlasGuardProof = null;
  return { json, asked };
}
const outcome = fn => { try { return 'value:' + fn(); } catch (err) { return 'throws:' + (err && err.constructor && err.constructor.name); } };

// Collect the corpus calls once (from the shipped copy), and a context
// (plan, options) from a held world for the invented rows below.
const calls = [];
let context = null;
for (const c of cases) {
  const { asked } = run(copies.shipped, c, true);
  for (const call of asked) calls.push(call);
  if (!context && c.kind === 'held' && asked.length) context = { plan: asked[0][2], opts: asked[0][3] };
}
// Invented rows that reach each guard. A credit is a negative amount (money in).
let rowSeq = 0;
const row = (over) => Object.assign({ id: 'inv-' + (++rowSeq), date: '2026-11-08',
  accountRole: 'household-cash', atlasAccountId: 'chequing-a', account: 'chequing-a', amount: -150,
  payee: 'Invented payer', category: 'Income', isIncome: true, pending: false }, over);
const invented = [
  row({ atlasAccountId: 'amanda-debt-payments', account: 'amanda-debt-payments' }),
  row({ atlasAccountId: 'amanda-debt-payments', account: 'amanda-debt-payments', isIncome: false, category: 'Groceries' }),
  row({ accountLabel: 'Tennis income' }),
  row({ atlasAccountId: 'amanda-debt-payments', account: 'amanda-debt-payments', amount: 150 }),
  row({ amount: 150 }),
  row({ amount: 150, isIncome: true, category: 'Income' }),
  row({ amount: 0 }),
  row({ isIncome: false, category: 'Groceries' }),
  row({ isIncome: false, category: 'Gifts' }),
  row({ payee: 'TFR-FR 1234 Invented', category: 'Transfer', isIncome: false }),
  row({ payee: 'ATM DEPOSIT Invented', originalMerchant: 'ATM DEPOSIT', isIncome: false, category: 'Uncategorized' }),
  row({ accountRole: 'household-reserve' }),
  row({ accountRole: 'household-reserve', atlasAccountId: 'amanda-debt-payments', account: 'amanda-debt-payments' }),
  row({ kindHint: 'transfer', isIncome: false }),
  row({ excludeFromTotals: true, isIncome: false }),
  // Rows the later checks would accept (a reserve credit flagged income, a
  // Groceries refund credit), carrying the tennis-account label: only the
  // tennis guard rejects them.
  row({ accountRole: 'household-reserve', accountLabel: 'Tennis income' }),
  row({ isIncome: false, category: 'Groceries', accountLabel: 'Tennis income' }),
];

console.log('1. Row by row: the same answer in both orders');
{
  let compared = 0, differ = 0, firstDiffer = '';
  const asks = calls.map(([kind, tx, plan, opts]) => [kind, tx, plan, opts, 'corpus'])
    .concat(context ? invented.flatMap(tx => [['income', tx, context.plan, context.opts, 'invented'],
      ['settle', tx, context.plan, context.opts, 'invented']]) : []);
  let credits = 0, tennisRejects = 0;
  for (const [kind, tx, plan, opts, source] of asks) {
    const a = outcome(() => copies.shipped['__' + kind](tx, plan, opts));
    const b = outcome(() => copies.reference['__' + kind](tx, plan, opts));
    compared++;
    if (a !== b) { differ++; if (!firstDiffer) firstDiffer = `${source} ${kind}: ${a} vs ${b}`; }
    if (Number(tx && tx.amount) < 0) credits++;
  }
  for (const tx of invented.filter(t => /tennis|amanda-debt/i.test(String(t.accountLabel) + t.account) && Number(t.amount) < 0)) {
    if (context && copies.shipped.__income(tx, context.plan, context.opts) === false
      && copies.shipped.__settle(tx, context.plan, context.opts) === false) tennisRejects++;
  }
  ok(context && calls.length > 1000 && compared === calls.length + 2 * invented.length && differ === 0,
    `${compared} answers (${calls.length} corpus calls, ${2 * invented.length} on invented rows) are the same in both orders`, firstDiffer);
  ok(credits > 20, 'the asks include credits that pass the inflow guard and reach the tennis guard', String(credits));
  ok(tennisRejects === 6, 'every invented tennis-account credit is rejected by both functions', String(tennisRejects));
}

console.log('2. Every row the corpus asks about is plain; a non-plain row is the only place order shows');
{
  const FIELDS = ['amount', 'atlasAccountId', 'accountId', 'account', 'accountLabel', 'accountName', 'payerLabel'];
  const plain = v => v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  let rows = 0, notPlain = 0, firstNotPlain = '';
  for (const [, tx] of calls) {
    rows++;
    for (const f of FIELDS) if (!plain(tx && tx[f])) { notPlain++; if (!firstNotPlain) firstNotPlain = f; }
  }
  ok(rows > 1000 && notPlain === 0, `all ${rows} asked rows carry plain values in every field the two guards read`, firstNotPlain);
  // An account field that throws when turned into text, on a debit.
  const hostile = row({ amount: 150, account: { name: { toString() { throw new Error('invented'); } } } });
  const now = outcome(() => copies.shipped.__income(hostile, context.plan, context.opts));
  const before = outcome(() => copies.reference.__income(hostile, context.plan, context.opts));
  ok(now === 'value:false' && before === 'throws:Error',
    'a debit whose account text throws: the new order rejects it as not an inflow, the old order threw', JSON.stringify({ now, before }));
  const credit = row({ account: { name: { toString() { throw new Error('invented'); } } } });
  const nowCredit = outcome(() => copies.shipped.__income(credit, context.plan, context.opts));
  const beforeCredit = outcome(() => copies.reference.__income(credit, context.plan, context.opts));
  ok(nowCredit === beforeCredit && nowCredit === 'throws:Error', 'the same row as a credit throws in both orders', JSON.stringify({ nowCredit, beforeCredit }));
}

console.log('3. Identical advice in both orders');
{
  let same = 0;
  for (const c of cases) {
    const now = run(copies.shipped, c).json, before = run(copies.reference, c).json;
    if (now === before && !now.startsWith('error')) same++;
    else ok(false, `${c.id}: advice identical`);
  }
  ok(cases.filter(c => c.kind === 'invented').length === 60 && same === cases.length,
    `advice identical on all ${cases.length} cases (60 invented evaluations, 2 held worlds, the 753-transaction world)`, `${same} of ${cases.length}`);
}

console.log('4. Mutants are caught; the early tennis guard decides no answer on its own');
const differOn = (name, kind) => {
  let n = 0;
  for (const tx of invented) {
    if (outcome(() => copies[name]['__' + kind](tx, context.plan, context.opts))
      !== outcome(() => copies.reference['__' + kind](tx, context.plan, context.opts))) n++;
  }
  for (const [k, tx, plan, opts] of calls) {
    if (k !== kind) continue;
    if (outcome(() => copies[name]['__' + kind](tx, plan, opts)) !== outcome(() => copies.reference['__' + kind](tx, plan, opts))) n++;
  }
  return n;
};
for (const [name, label, kind] of [['noIncomeInflow', 'no inflow guard in the income test', 'income'],
  ['settleInflowFlipped', 'the settlement inflow guard flipped', 'settle'],
  ['tennisTooWide', 'a tennis-account test that also matches household chequing', 'income']]) {
  const n = differOn(name, kind);
  ok(n > 0, `${label} is caught`, `${n} answers differ`);
}
// Removing the early tennis guard changes no answer, on the corpus or on the
// invented tennis rows: txMatchesScheduledIncome rejects the same account
// text later. The guard is a fast path, which is why its place is free.
ok(differOn('noIncomeTennis', 'income') === 0 && differOn('noSettleTennis', 'settle') === 0,
  'without the early tennis guard every answer is the same: the later scheduled-income check rejects the same rows');

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} income-guard checks passed`);
process.exit(failures ? 1 : 0);
