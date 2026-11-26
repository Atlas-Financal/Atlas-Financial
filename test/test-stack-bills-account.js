'use strict';
/* The Bills account stack card (Dale's decision recorded on #821; lead brief #1620 7181064255). Forecast publishes, per
 * active pay period, stackSummary.billsAccount:
 *   - now: the Bills bank reading (billsAccountPeriodBalance.observedCash and its date), unchanged;
 *   - transactions: only the Bills account's own ledger transactions for the current pay period, newest first, straight
 *     from the transaction packet Forecast already has (no matching or pairing, rule 17). Money in reads as in, pending
 *     rows read as pending; an unreadable list is withheld (a dash on the card, never a sentence).
 * Coming in, Coming out, Household budget still to move, and Already out are retired.
 *
 *   1. An invented world with a posted debit, a posted credit (money in), a pending row, a transfer, and rows from
 *      Weekly, Savings, a card, and outside the pay period: only Bills current-period rows appear, newest first; the
 *      close itself (billsAccountPeriodBalance) is byte-equal to main; the figures snapshot captures only the new fields.
 *   2. Unpaired transfer and unrelated close withholding leave the Bills transaction list readable; stale/incomplete
 *      coverage/missing packet/unreadable Bills rows withhold the list cleanly; closed reading gates stay intact.
 *   3. End to end through recommend and the real stack-cards.js: closed card unchanged, open card shows only the Bills
 *      transactions, retired sections are gone, unreadable list prints only a dash, hostile payees are escaped.
 *   4. Mutants: letting a Weekly-account row in, dropping period bounds, reversing order, dropping money-in or pending,
 *      weakening coverage/reading guards, and page-side regressions are all caught.
 *
 * Invented data only (test/fixtures/bills-period-end-balance-data.js plus invented ledger rows).
 * `node test/test-stack-bills-account.js`
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const fx = require('./fixtures/bills-period-end-balance-data');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const cents = v => Math.round(v * 100);
const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

const BASE = '5f8d00aa35bfcce1ba00920ed96efc5e2221193a'; // main before this change (#1644 and #1652 merged)
const show = file => cp.execFileSync('git', ['show', BASE + ':' + file], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
function engine(sources) {
  const c = { console };
  c.window = c;
  vm.createContext(c);
  for (const file of ['public/display-name.js', 'public/forecast-card-period.js', 'public/forecast.js']) vm.runInContext(sources(file), c);
  return c.Forecast;
}

// Invented world based on bills-period-end-balance-data (as of 2026-08-20, period 2026-08-14..2026-08-27).
// Bills account (chequing-a) current-period transactions (expected newest first, pending before posted on same day):
//   1. bills-pending   2026-08-20  58.90 out (pending)  "Invented Pending Hydro"
//   2. card-debit      2026-08-20 111.11 out (posted)   "Invented card-debit"
//   3. direct-grocery  2026-08-19  31.27 out (posted)   "Invented direct-grocery"
//   4. weekly-debit    2026-08-18 240.16 out (transfer) "AB123 TFR-TO invented"
//   5. bills-credit    2026-08-17 412.50 in  (posted)   "Invented Employer Payroll"
// Must NOT appear:
//   - weekly-credit, weekly-dining (chequing-b)
//   - savings-tx (savings)
//   - card-purchase, card-credit (travelvisa)
//   - prior-period-bills (chequing-a, 2026-08-13), next-period-bills (chequing-a, 2026-08-28)
function world(mode) {
  const d = fx.served(), pk = d.liveOverlay.currentPeriodActuals;
  pk.transactions.push(
    fx.tx('bills-credit', 'chequing-a', '2026-08-17', -412.50, 'Income', { displayedPayee: 'Invented Employer Payroll', isIncome: true }),
    fx.tx('bills-pending', 'chequing-a', '2026-08-20', 58.90, 'Utilities', { displayedPayee: 'Invented Pending Hydro', pending: true }),
    fx.tx('savings-tx', 'savings', '2026-08-19', 75.00, 'Transfer', { displayedPayee: 'Invented Savings Row', accountRole: 'household-reserve' }),
    fx.tx('prior-period-bills', 'chequing-a', '2026-08-13', 19.99, 'Utilities', { displayedPayee: 'Invented Prior Period' }),
    fx.tx('next-period-bills', 'chequing-a', '2026-08-28', 29.99, 'Utilities', { displayedPayee: 'Invented Next Period' }),
  );
  if (mode === 'unpaired') pk.transactions = pk.transactions.filter(tx => tx.id !== 'weekly-credit');
  if (mode === 'stale') d.liveOverlay.operatingPlan = 'unavailable';
  if (mode === 'misaligned') d.liveOverlay.observedCash.accounts[0].value = 1400.01;
  if (mode === 'missing') {
    d.plan.startingCash.breakdown = d.plan.startingCash.breakdown.filter(r => r.id !== 'chequing-a');
    d.liveOverlay.observedCash.accounts = d.liveOverlay.observedCash.accounts.filter(r => r.id !== 'chequing-a');
  }
  if (mode === 'no-observation') {
    d.liveOverlay.observedCash.accounts = d.liveOverlay.observedCash.accounts.filter(r => r.id !== 'chequing-a');
  }
  if (mode === 'window-incomplete') {
    d.liveOverlay.observedCash.accounts.find(r => r.id === 'chequing-a').evidenceDate = '2026-08-17';
    pk.coverageThrough = '2026-08-17'; pk.transactionCoverage = 'partial';
    pk.transactions = pk.transactions.filter(r => r.date <= '2026-08-17');
  }
  if (mode === 'pending-incomplete') pk.pendingCoverage = 'partial';
  if (mode === 'no-packet') d.liveOverlay.currentPeriodActuals = null;
  if (mode === 'bad-currency') pk.transactions.push(fx.tx('usd-bills', 'chequing-a', '2026-08-19', 12.00, 'Utilities', { currency: 'usd' }));
  if (mode === 'bad-date') pk.transactions.push(fx.tx('bad-date-bills', 'chequing-a', '2026-99-99', 12.00, 'Utilities'));
  if (mode === 'empty-bills') pk.transactions = pk.transactions.filter(tx => tx.account !== 'chequing-a');
  if (mode === 'unknown-bill') {
    d.plan.bills.push({ id: 'unknown-amount', label: 'Invented unknown bill', frequency: 'once', date: '2026-08-26',
      amount: null, confidence: 'confirmed', payingAccount: 'chequing-a' });
  }
  d.meta = { ...(d.meta || {}), asOf: fx.AS_OF };
  return d;
}
const advise = (E, d) => E.recommend(d.plan, fx.AS_OF, E.budgetRecommendInputs(d, {}));
const activeOf = advice => advice.payPeriodViews.find(v => v.role === 'active');

console.log('1. Bills account publishes only its own current-period ledger transactions, newest first');
const advice = advise(F, world());
const view = activeOf(advice);
const ba = view.stackSummary.billsAccount;
const close = view.billsAccountPeriodBalance;
ok(ba && ba.status === 'ready' && ba.reason === null, 'the card is published, ready, for the active pay period', JSON.stringify(ba && ba.status));
ok(JSON.stringify(Object.keys(ba).sort()) === JSON.stringify(['now', 'reason', 'status', 'transactions']),
  'retired fields (comingIn, comingOut, householdToMove, alreadyOut) are gone from stackSummary.billsAccount', JSON.stringify(Object.keys(ba)));
ok(cents(ba.now.amount) === 137329 && ba.now.asOf === '2026-08-20' && ba.now.trust === 'estimated' && ba.now.reason === null,
  'closed reading unchanged: 1373.29, read 2026-08-20, tagged estimated', JSON.stringify(ba.now));
assert.deepEqual(ba.transactions, [
  { id: 'bills-pending', label: 'Invented Pending Hydro', date: '2026-08-20', amount: 58.9, direction: 'out', pending: true, trust: 'estimated' },
  { id: 'card-debit', label: 'Invented card-debit', date: '2026-08-20', amount: 111.11, direction: 'out', pending: false, trust: 'calculated' },
  { id: 'direct-grocery', label: 'Invented direct-grocery', date: '2026-08-19', amount: 31.27, direction: 'out', pending: false, trust: 'calculated' },
  { id: 'weekly-debit', label: 'AB123 TFR-TO invented', date: '2026-08-18', amount: 240.16, direction: 'out', pending: false, trust: 'calculated' },
  { id: 'bills-credit', label: 'Invented Employer Payroll', date: '2026-08-17', amount: 412.5, direction: 'in', pending: false, trust: 'calculated' },
]);
ok(true, 'exact Bills transactions newest first: pending debit, posted debits, transfer, posted credit (money in)');
for (const excludedId of ['weekly-credit', 'weekly-dining', 'savings-tx', 'card-purchase', 'card-credit', 'prior-period-bills', 'next-period-bills']) {
  ok(!ba.transactions.some(r => r.id === excludedId), 'excluded row never appears: ' + excludedId);
}
ok(advice.payPeriodViews.filter(v => v.role !== 'active').every(v => !v.stackSummary || v.stackSummary.billsAccount === null),
  'no other pay period carries the card');

// Pending credit (money in + pending) and split parent with children (parent skipped, children listed once).
{
  const d = world();
  d.liveOverlay.currentPeriodActuals.transactions.push(
    fx.tx('pending-refund', 'chequing-a', '2026-08-20', -25.40, 'Refund', { displayedPayee: 'Invented Pending Credit', pending: true }),
    fx.tx('split-parent', 'chequing-a', '2026-08-16', 100.00, 'Split', { displayedPayee: 'Split Parent', isGroup: true }),
    fx.tx('split-child-a', 'chequing-a', '2026-08-16', 60.00, 'Groceries', { displayedPayee: 'Split Child A', parentId: 'split-parent' }),
    fx.tx('split-child-b', 'chequing-a', '2026-08-16', 40.00, 'Utilities', { displayedPayee: 'Split Child B', parentId: 'split-parent' }),
  );
  const txs = activeOf(advise(F, d)).stackSummary.billsAccount.transactions;
  const pc = txs.find(r => r.id === 'pending-refund');
  ok(pc && pc.direction === 'in' && pc.pending === true && pc.amount === 25.4 && pc.trust === 'estimated',
    'pending credit carries direction in, pending true, estimated trust', JSON.stringify(pc));
  ok(!txs.some(r => r.id === 'split-parent') && txs.some(r => r.id === 'split-child-a') && txs.some(r => r.id === 'split-child-b'),
    'split parent with children is skipped; split children appear once');
}

// The close itself (billsAccountPeriodBalance) is byte-equal to main across worlds.
const OLD = engine(show);
for (const mode of [undefined, 'unpaired', 'no-observation', 'window-incomplete', 'unknown-bill']) {
  const curClose = activeOf(advise(F, world(mode))).billsAccountPeriodBalance;
  const oldClose = activeOf(advise(OLD, world(mode))).billsAccountPeriodBalance;
  ok(JSON.stringify(curClose) === JSON.stringify(oldClose),
    (mode || 'base') + ': billsAccountPeriodBalance is byte-equal to main');
}
ok(JSON.stringify(advice.defaultView.billsAccountPeriodBalance) === JSON.stringify(close),
  'the default view publishes the same close');

{
  // The figures snapshot captures the reading and each Bills account transaction, and none of the retired fields or other accounts.
  const snap = require('../scripts/figures-snapshot').buildFiguresSnapshot(world(), null);
  const k = 'period.' + view.start + '.';
  const want = {
    stackBillsAccountStatus: 'ready',
    stackBillsAccountNow: 1373.29,
    stackBillsAccountNowAsOf: '2026-08-20',
    stackBillsAccountNowTrust: 'estimated',
    'stackBillsAccountTx.bills-pending@2026-08-20.amount': 58.9,
    'stackBillsAccountTx.bills-pending@2026-08-20.direction': 'out',
    'stackBillsAccountTx.bills-pending@2026-08-20.pending': true,
    'stackBillsAccountTx.bills-pending@2026-08-20.trust': 'estimated',
    'stackBillsAccountTx.bills-credit@2026-08-17.amount': 412.5,
    'stackBillsAccountTx.bills-credit@2026-08-17.direction': 'in',
    'stackBillsAccountTx.bills-credit@2026-08-17.pending': false,
    'stackBillsAccountTx.bills-credit@2026-08-17.trust': 'calculated',
    'stackBillsAccountTx.weekly-debit@2026-08-18.amount': 240.16,
  };
  const bad = Object.entries(want).filter(([key, value]) => snap[k + key] !== value);
  const retired = Object.keys(snap).filter(key => /stackBillsAccount(Household|In\.|Out\.|Settled\.)/.test(key));
  const leaked = Object.keys(snap).filter(key => key.includes('stackBillsAccountTx') && /(weekly-credit|weekly-dining|savings-tx|card-purchase|prior-period|next-period)/.test(key));
  ok(!bad.length && !retired.length && !leaked.length,
    'figures snapshot records the reading and Bills account transactions, with no retired fields and no other-account rows',
    JSON.stringify({ bad, retired, leaked }));
}

console.log('2. Unpaired transfers, close withholding, reading guards, and unreadable list states');
{
  const v = activeOf(advise(F, world('unpaired')));
  ok(v.billsAccountPeriodBalance.issues.some(i => i.code === 'unpaired-bills-transfer') && v.billsAccountPeriodBalance.status === 'unavailable',
    'unpaired transfer still withholds the close');
  assert.deepEqual(v.stackSummary.billsAccount.transactions, ba.transactions);
  ok(v.stackSummary.billsAccount.status === 'ready', 'unpaired transfer still appears once in Bills transactions with no matching or pairing');
}
{
  const v = activeOf(advise(F, world('unknown-bill')));
  ok(v.billsAccountPeriodBalance.status === 'unavailable' && v.stackSummary.billsAccount.status === 'ready'
    && v.stackSummary.billsAccount.now.amount === 1373.29 && v.stackSummary.billsAccount.transactions.length === 5,
    'an unknown planned bill withholds the close but leaves both the bank reading and Bills transactions readable');
}
for (const [mode, code] of [['stale', 'operating-plan-unavailable'], ['misaligned', 'cash-observation-misaligned'],
  ['missing', 'bills-cash-unavailable'], ['window-incomplete', 'posted-window-incomplete']]) {
  const v = activeOf(advise(F, world(mode))), b = v.stackSummary.billsAccount;
  const issue = v.billsAccountPeriodBalance.issues.find(i => i.code === code);
  ok(b && b.now.amount === null && b.now.asOf === null && b.now.trust === 'unavailable' && issue && b.now.reason === issue.message,
    mode + ': unreadable reading is null with the close\'s own reason (' + code + ')', JSON.stringify(b && b.now));
}
{
  const v = activeOf(advise(F, world('no-observation'))), b = v.stackSummary.billsAccount;
  ok(b && b.now.amount === null && b.now.asOf === null && b.now.trust === 'unavailable'
    && b.now.reason === 'No bank reading of the Bills account is available.',
    'no-observation: plan row alone is not a reading', JSON.stringify(b && b.now));
}
for (const mode of ['stale', 'window-incomplete', 'pending-incomplete', 'no-packet', 'bad-currency', 'bad-date']) {
  const v = activeOf(advise(F, world(mode))), b = v.stackSummary.billsAccount;
  ok(b && b.status === 'unavailable' && b.transactions === null && typeof b.reason === 'string' && b.reason.length > 0,
    mode + ': unreadable transaction list is withheld (null with reason)', JSON.stringify(b && { status: b.status, reason: b.reason }));
}
{
  const v = activeOf(advise(F, world('empty-bills'))), b = v.stackSummary.billsAccount;
  ok(b && b.status === 'ready' && Array.isArray(b.transactions) && b.transactions.length === 0,
    'empty-bills: complete period with zero Bills transactions is ready with []');
}

console.log('3. Through the real stack-cards.js');
const shellBox = { window: {}, location: { search: '' }, URLSearchParams, Intl, Map, Number, String, Object, Array, JSON, Math, console };
vm.runInNewContext(read('public/stack-shell.js'), shellBox);
const shell = shellBox.window.StackBlocks;
const STACK = { register: () => {}, isEstimated: shell.isEstimated, estClass: shell.estClass, budgetTrust: shell.budgetTrust,
  barWidth: shell.barWidth, money: shell.money, billName: shell.billName };
function loadCards(source) {
  const box = { module: { exports: {} }, window: { StackBlocks: STACK }, StackBlocks: STACK, Intl, Date };
  box.exports = box.module.exports;
  vm.runInNewContext(source, box);
  return box.module.exports;
}
const CARDS = loadCards(read('public/stack-cards.js'));
const cardOf = (v, cards = CARDS) => {
  const html = cards.buildCardsHTML({ data: {}, plan: {}, recommendation: { payPeriodViews: [v] }, selectedPeriodKey: v.start });
  const at = html.indexOf('data-stack-card="billsacct"');
  return at < 0 ? null : html.slice(html.lastIndexOf('<details', at), html.indexOf('</details>', at));
};
const text = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const head = h => text(h.slice(h.indexOf('<summary'), h.indexOf('</summary>')));
const card = cardOf(view);
ok(card && head(card) === 'Bills account Bank reading Aug 20 $1,373 now', 'closed: "Bills account", "Bank reading Aug 20", "$1,373 now"', head(card || ''));
ok(!/sc-bar/.test(card), 'no bar on the card head');
const body = text(card.slice(card.indexOf('</summary>')));
ok(body === 'Invented Pending Hydro Aug 20 · Pending $58.90 Invented card-debit Aug 20 $111.11 Invented direct-grocery Aug 19 $31.27 '
  + 'AB123 TFR-TO invented Aug 18 $240.16 Invented Employer Payroll Aug 17 +$412.50',
  'open: only Bills transactions, newest first, money in with +, pending marked Pending', body);
ok(/class="sc-row sc-acct sc-pending"/.test(card), 'pending row carries the sc-pending class');
ok(/class="sc-a sc-in" aria-label="Money in \+\$412\.50">\+\$412\.50<\/span>/.test(card), 'money-in row carries sc-in class and + sign');
ok(!/Coming in|Coming out|Household budget still to move|Already out|sc-cap|sc-check|data-stack-sheet|sc-why/.test(card),
  'retired sections, checkmarks, bill sheets, and explanatory sentences are gone from the card');
for (const excludedText of ['weekly-credit', 'weekly-dining', 'Savings Row', 'card-purchase', 'Prior Period', 'Next Period']) {
  ok(!card.includes(excludedText), 'other-account or out-of-period row not printed: ' + excludedText);
}
for (const mode of ['stale', 'window-incomplete', 'pending-incomplete', 'no-packet', 'bad-currency']) {
  const v = activeOf(advise(F, world(mode))), h = cardOf(v), b = v.stackSummary.billsAccount;
  const openBody = text(h.slice(h.indexOf('</summary>')));
  ok(openBody === '—' && !h.includes(b.reason) && !h.includes('sc-why'),
    mode + ': unreadable list renders only a dash, never a sentence', openBody);
}
for (const mode of ['stale', 'misaligned', 'missing', 'no-observation', 'window-incomplete']) {
  const v = activeOf(advise(F, world(mode))), h = cardOf(v), b = v.stackSummary.billsAccount;
  ok(h && head(h) === 'Bills account —' && !h.includes(b.now.reason) && !h.includes('sc-why'),
    mode + ': unreadable reading head is a dash without a sentence', head(h || ''));
}
{
  const h = cardOf(activeOf(advise(F, world('empty-bills'))));
  const openBody = text(h.slice(h.indexOf('</summary>')));
  ok(openBody === '' && !h.includes('sc-unavailable'), 'ready empty list prints no unavailable dash and no sentence', openBody);
}
{
  const d = world();
  d.liveOverlay.currentPeriodActuals.transactions.push(
    fx.tx('hostile-payee', 'chequing-a', '2026-08-20', 10.00, 'Utilities', { displayedPayee: '"><img src=x onerror=alert(1)>' }),
  );
  const h = cardOf(activeOf(advise(F, d)));
  ok(!h.includes('<img src=x') && h.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'), 'hostile payee is escaped');
}
{
  const other = advice.payPeriodViews.find(v => v.role !== 'active' && v.stackSummary);
  ok(other && cardOf(other) === null, 'no card on another pay period');
}
ok(!/estimat/i.test(card) && !/sc-est|est-/i.test(card), 'no estimate styling and no estimate words on the card');

console.log('4. Mutants');
const mutant = (label, file, from, to, check) => {
  const src = read(file);
  assert.ok(src.includes(from), 'mutant anchor missing: ' + label);
  const sources = f => f === file ? src.replace(from, to) : read(f);
  let caught = false;
  try { caught = !check(sources); } catch (e) { caught = true; }
  ok(caught, 'mutant caught: ' + label);
};
const fresh = sources => activeOf(advise(engine(sources), world())).stackSummary.billsAccount;
// Required mutant: letting a Weekly-account (chequing-b) row in MUST fail!
mutant('a Weekly-account row leaks into Bills transactions', 'public/forecast.js',
  'if (loc !== BILLS_ACCOUNT_ID) continue;',
  'if (loc !== BILLS_ACCOUNT_ID && loc !== WEEKLY_ACCOUNT_ID) continue;',
  sources => {
    const txs = fresh(sources).transactions;
    return !txs.some(r => r.id === 'weekly-dining' || r.id === 'weekly-credit');
  });
mutant('rows outside the current pay period leak in', 'public/forecast.js',
  'if (tx.date < cycle.start || tx.date > cycle.end) continue;',
  'if (false) continue;',
  sources => !fresh(sources).transactions.some(r => r.id === 'prior-period-bills' || r.id === 'next-period-bills'));
mutant('newest-first sort reversed', 'public/forecast.js',
  'rows.sort((a, b) => b.date.localeCompare(a.date)',
  'rows.sort((a, b) => a.date.localeCompare(b.date)',
  sources => fresh(sources).transactions[0].date === '2026-08-20' && fresh(sources).transactions[4].date === '2026-08-17');
mutant('money-in direction dropped', 'public/forecast.js',
  "direction: tx.amount < 0 ? 'in' : 'out',",
  "direction: 'out',",
  sources => fresh(sources).transactions.find(r => r.id === 'bills-credit').direction === 'in');
mutant('pending flag dropped', 'public/forecast.js',
  'const pending = tx.pending === true;\n      const label =',
  'const pending = false;\n      const label =',
  sources => fresh(sources).transactions.find(r => r.id === 'bills-pending').pending === true);
mutant('pending coverage gate dropped', 'public/forecast.js',
  "if (pendingCoverageStatus(packet) !== 'complete') {",
  'if (false) {',
  sources => activeOf(advise(engine(sources), world('pending-incomplete'))).stackSummary.billsAccount.status === 'unavailable');
mutant('the reading guard dropped', 'public/forecast.js',
  'const now = !readingIssue && observed && finite(pub.observedCash)',
  'const now = observed && finite(pub.observedCash)',
  sources => activeOf(advise(engine(sources), world('misaligned'))).stackSummary.billsAccount.now.amount === null);
mutant('no observation still prints the plan row', 'public/forecast.js',
  'const now = !readingIssue && observed && finite',
  'const now = !readingIssue && finite',
  sources => activeOf(advise(engine(sources), world('no-observation'))).stackSummary.billsAccount.now.amount === null);
mutant('an incomplete posted window still prints the reading', 'public/forecast.js',
  "'posted-window-incomplete']);",
  ']);',
  sources => activeOf(advise(engine(sources), world('window-incomplete'))).stackSummary.billsAccount.now.amount === null);
{
  const src = read('public/stack-cards.js');
  const fromPending = "var pending = item.pending === true;";
  assert.ok(src.includes(fromPending), 'mutant anchor missing: stack-cards pending');
  ok(!/· Pending/.test(text(cardOf(view, loadCards(src.replace(fromPending, 'var pending = false;'))))),
    'mutant caught: stack-cards drops the pending marker');
  const fromIn = "var incoming = item.direction === 'in';";
  assert.ok(src.includes(fromIn), 'mutant anchor missing: stack-cards incoming');
  ok(!/\+\$412\.50/.test(text(cardOf(view, loadCards(src.replace(fromIn, 'var incoming = false;'))))),
    'mutant caught: stack-cards drops the money-in sign');
}

console.log(`\n${checks} checks passed`);
