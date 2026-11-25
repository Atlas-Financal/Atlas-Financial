'use strict';

// Repros from #1607, findings 5 and 8. All inputs are invented. Run with
// node test/test-stack-bill-account-agreement.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const H = require('./acceptance/harness');
const fx = require('./fixtures/bills-period-end-balance-data');
const { buildFiguresSnapshot } = require('../scripts/figures-snapshot');

const ROOT = path.join(__dirname, '..');
const BASE = '6fd82fa939a317b56d0f5536efde8e9e671c3439';
const read = file => fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
const before = file => execFileSync('git', ['show', BASE + ':public/' + file], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
});
const forecastSource = read('forecast.js');
const cardsSource = read('stack-cards.js');

function forecast(source) {
  const filename = path.join(ROOT, 'public/forecast.js');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod._compile(source, filename);
  return mod.exports;
}

function cards(source) {
  const box = { location: { search: '' }, URLSearchParams, Intl, module: { exports: {} } };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(read('stack-shell.js'), box);
  vm.runInContext(source, box);
  return box.module.exports.buildCardsHTML;
}

function utility(planned, actual, posted = false) {
  const data = fx.served(), date = '2026-08-16', id = 'utility';
  data.plan.bills = [{ id, label: 'Invented utility', frequency: 'once', date,
    amount: planned, confidence: 'confirmed', payingAccount: 'chequing-a' }];
  const packet = data.liveOverlay.currentPeriodActuals;
  const represented = { id, date, actual };
  if (posted) {
    packet.transactions.push(fx.tx('utility-debit', 'chequing-a', date, actual, 'Utilities'));
    Object.assign(represented, { postedOn: date, transactionId: 'utility-debit' });
  }
  packet.representedActuals.push(represented);
  return { data, asOf: fx.AS_OF, id, date, planned, actual };
}

function partial(id, planned, actual, remainder) {
  const w = H.baseWorld('2026-10-14'), date = '2026-10-12';
  const fee = id === 'tdfees', payee = fee ? 'Bank fees' : 'Invented hydro';
  w.bills = [{ id, label: payee, amount: planned, frequency: 'monthly', day: 12,
    confidence: 'confirmed', payee, payingAccount: 'chequing-a' }];
  const pay = (amount, on) => H.lm({ amount, date: on, account: 'chequing-a', payee,
    category: fee ? 'Bank Fees' : 'Utilities' });
  w.transactions = [pay(actual, date)];
  if (!fee) w.amountHistory = { transactions: ['2026-07-12', '2026-08-12', '2026-09-12']
    .map(on => pay(planned, on)).concat(w.transactions) };
  const { data, error } = H.dataOf(w);
  if (error) throw error;
  return { data, asOf: w.asOf, id, date, planned, actual, remainder };
}

const unposted = [utility(45, 45), utility(80, 30)];
const installments = [partial('hydro', 90, 40, 50), partial('tdfees', 24, 16, 8)];
const complete = utility(45, 45, true);
const live = { F: forecast(forecastSource), render: cards(cardsSource) };
const old = { F: forecast(before('forecast.js')), render: cards(before('stack-cards.js')) };
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const amounts = html => text(html).match(/\$[\d,]+/g) || [];
const money = n => '$' + n;

function inspect(engine, testCase) {
  const { data, asOf, id, date } = testCase;
  const opts = engine.F.budgetRecommendInputs(data, {});
  const recommendation = engine.F.recommend(data.plan, asOf, opts);
  const view = recommendation.payPeriodViews.find(v => v.role === 'active');
  const html = engine.render({ data, plan: data.plan, recommendation, selectedPeriodKey: view.start, Forecast: engine.F });
  const card = name => html.split('data-stack-card="' + name + '"')[1].split('</details>')[0];
  const target = 'data-stack-sheet="bill:' + id + '@' + date + '"';
  const billRows = card('bills').match(/<li\b[^>]*>[\s\S]*?<\/li>/g).filter(li => li.includes(target));
  assert.equal(billRows.length, 1, 'one Bills row for the occurrence');
  const accountCard = card('billsacct');
  const accountRows = (accountCard.match(/<li\b[^>]*>[\s\S]*?<\/li>/g) || []).filter(li => li.includes(target));
  const account = view.stackSummary.billsAccount;
  assert.equal(account.status, 'ready');
  const lines = key => (account[key] || []).filter(line => line.id === id && line.date === date);
  return { bills: view.stackSummary.bills, row: view.bills.find(r => r.id === id && r.date === date),
    head: text(card('bills').split('</summary>')[0]), bill: billRows[0], account: accountCard, accountRows,
    paid: lines('alreadyOut'), due: lines('comingOut'), unconfirmed: lines('postedUnconfirmed'),
    close: view.billsAccountPeriodBalance };
}

function verifyUnposted(s, c) {
  assert.equal(s.bills.paid, 0);
  assert.equal(s.bills.other, c.planned);
  assert.equal(s.paid.length, 0, 'a represented amount without a posted link is never Already out');
  assert.equal(s.unconfirmed.length, 0, 'a represented amount without a posted link is never labeled posted');
  assert.doesNotMatch(s.account, /Invented utility/);
}

function verifyPartial(s, c) {
  assert.equal(s.bills.paid, 0);
  assert.equal(s.bills.other, c.planned);
  assert.ok(s.head.includes('$0 / ' + money(c.planned)));
  assert.equal(s.paid.length, 0, 'an unconfirmed debit contributes zero to Already out');
  assert.doesNotMatch(s.bill, /aria-label="Paid"/);
  assert.deepEqual(s.due.map(l => l.amount), [c.remainder], 'once under Coming out');
  assert.deepEqual(s.unconfirmed.map(l => l.amount), [c.actual], 'once under Posted but unconfirmed');
  assert.deepEqual(amounts(s.bill).sort(), [money(c.remainder), money(c.actual)].sort(), 'Bills row shows both parts once');
  assert.ok(text(s.bill).includes('Remaining ' + money(c.remainder)));
  assert.ok(text(s.bill).includes('Posted but unconfirmed ' + money(c.actual)));
  assert.doesNotMatch(text(s.account), /Already out/);
  assert.deepEqual(s.accountRows.flatMap(amounts).sort(), [money(c.remainder), money(c.actual)].sort(),
    'the two account sections list the occurrence once each');
  const [comingOut, unconfirmed] = text(s.account).split('Posted but unconfirmed');
  assert.ok(comingOut.includes('Coming out') && comingOut.includes(money(c.remainder)));
  assert.ok(unconfirmed && unconfirmed.includes(money(c.actual)));
}

function verifyFull(s) {
  assert.equal(s.bills.paid, 45);
  assert.equal(s.row.stackBillAmount, 45);
  assert.equal(s.row.stackBillAmountTrust, 'calculated');
  assert.deepEqual(s.paid.map(l => [l.amount, l.trust, l.paid]), [[45, 'calculated', true]],
    'the checked Bills amount and trust appear once under Already out');
  assert.ok(s.head.includes('$45 / $45'));
  assert.match(s.bill, /aria-label="Paid"/);
  assert.deepEqual(amounts(s.bill), ['$45']);
  assert.match(text(s.account), /Already out Invented utility Aug 16 \$45/);
  assert.equal(s.due.length + s.unconfirmed.length, 0);
}

for (const c of [...unposted, ...installments]) {
  const was = inspect(old, c), now = inspect(live, c);
  assert.equal(was.bills.paid, 0);
  assert.deepEqual(amounts(was.bill), [money(c.planned)]);
  assert.deepEqual(was.accountRows.flatMap(amounts), [money(c.remainder ?? c.planned)]);
  assert.deepEqual(was.paid.map(l => [l.amount, l.trust]), c.remainder ? [] : [[c.planned, 'calculated']]);
  assert.deepEqual(was.due.map(l => l.amount), c.remainder ? [c.remainder] : []);
  assert.deepEqual(now.close, was.close, 'the Bills account close is unchanged');
  (c.remainder ? verifyPartial : verifyUnposted)(now, c);
}
verifyFull(inspect(live, complete));

// The snapshot is what the lead compares before handoff. Both posted portions
// have their own dated amount and trust, and neither appears under Settled.
for (const c of installments) {
  const snap = buildFiguresSnapshot(c.data, null);
  const period = 'period.2026-10-09.stackBillsAccount';
  const occurrence = '.' + c.id + '@' + c.date;
  assert.equal(snap[period + 'PostedUnconfirmed' + occurrence + '.amount'], c.actual);
  assert.equal(snap[period + 'PostedUnconfirmed' + occurrence + '.trust'], 'calculated');
  assert.equal(snap[period + 'Out' + occurrence + '.amount'], c.remainder);
  assert.equal(snap[period + 'Out' + occurrence + '.partial'], true);
  assert.ok(!Object.hasOwn(snap, period + 'Settled' + occurrence + '.amount'));
}

// The plan names Bills as payer. Only the linked transaction is changed here:
// a Weekly-account debit and a credit into Bills cannot be outgoing Bills cash.
// The existing Bills confirmation rule and the close still have their own scopes.
function otherMovement(c, account, sign) {
  const copy = structuredClone(c);
  const packet = copy.data.liveOverlay.currentPeriodActuals;
  const claim = packet.representedActuals.find(item => item.id === c.id && item.date === c.date);
  const tx = packet.transactions.find(item => item.id === claim.transactionId);
  Object.assign(tx, { atlasAccountId: account, account, amount: sign * copy.actual });
  return copy;
}
const wrongMovements = [installments[0], complete].flatMap(c =>
  [otherMovement(c, 'chequing-b', 1), otherMovement(c, 'chequing-a', -1)]);
function verifyOtherMovement(s, c) {
  assert.equal(s.bills.paid, c.remainder ? 0 : c.actual, 'incumbent confirmation is unchanged');
  assert.equal(s.paid.length, 0, 'a linked credit or a debit from another account cannot be Already out');
  assert.equal(s.unconfirmed.length, 0, 'only a Bills debit can be disclosed as posted on the account card');
  assert.doesNotMatch(text(s.account), /Already out|Posted but unconfirmed/);
  if (c.remainder) {
    assert.deepEqual(s.due.map(row => row.amount), [c.remainder]);
    assert.deepEqual(amounts(s.bill), [money(c.remainder)]);
  }
}
for (const c of wrongMovements) verifyOtherMovement(inspect(live, c), c);

function replaceOnce(source, from, to) {
  assert.equal(source.split(from).length, 2, 'unique source anchor: ' + from);
  return source.replace(from, to);
}
// Supply an absent upstream trust word before the normal Bills paid and card publications run.
const missingTrust = replaceOnce(forecastSource, 'publishStackBillParts(view, bills);',
  "publishStackBillParts(view, bills); for (const row of view.bills || []) if (row.id === 'utility') delete row.stackBillAmountTrust;");
function verifyMissing(s) {
  assert.equal(s.bills.paid, null);
  assert.equal(s.bills.paidTrust, 'unavailable');
  assert.equal(s.paid.length, 0, 'a checked amount without trust cannot be reported as paid');
  assert.doesNotMatch(s.account, /Invented utility/);
  assert.deepEqual(amounts(s.bill), [], 'Bills amount without trust is withheld');
}
verifyMissing(inspect({ ...live, F: forecast(missingTrust) }, complete));

function rendererMutant(name, from, to, testCase, verify) {
  const render = cards(replaceOnce(cardsSource, from, to));
  const result = inspect({ ...live, render }, testCase);
  assert.throws(() => verify(result, testCase), assert.AssertionError, name);
}
rendererMutant('substitute the full planned amount for the partial', 'if (!remainder) return stateRow(label, r, target);',
  'return stateRow(label, r, target);', installments[0], verifyPartial);
rendererMutant('silently drop the unconfirmed label', "accountSection('Posted but unconfirmed', list(ba.postedUnconfirmed",
  "accountSection('Already out', list(ba.postedUnconfirmed", installments[1], verifyPartial);

const unlinked = structuredClone(installments[0]);
delete unlinked.data.liveOverlay.currentPeriodActuals.representedActuals[0].transactionId;
function verifyUnlinked(s) {
  assert.equal(s.bills.paid, 0);
  assert.equal(s.paid.length, 0);
  assert.deepEqual(s.due.map(l => l.amount), [50]);
  assert.deepEqual(amounts(s.bill), ['$50']);
  assert.equal(s.unconfirmed.length, 0, 'a represented partial alone cannot supply a posted amount');
  assert.doesNotMatch(s.bill + s.account, /Posted but unconfirmed/);
}
verifyUnlinked(inspect(live, unlinked));

function forecastMutant(name, source, from, to, testCase, verify) {
  const F = forecast(replaceOnce(source, from, to));
  const result = inspect({ ...live, F }, testCase);
  assert.throws(() => verify(result, testCase), assert.AssertionError, name);
}
const paidGate = 'if (own && row.stackBillPaid === true && finite(bills.paid) && billsDebit) {';
forecastMutant('report represented plans as already out', forecastSource, paidGate,
  'if (own && finite(bills.paid)) {', unposted[1], verifyUnposted);
forecastMutant('drop the confirmed paid occurrence', forecastSource, paidGate,
  'if (false) {', complete, verifyFull);
forecastMutant('weaken paid trust on the account', forecastSource, 'trust: row.stackBillAmountTrust, paid: true',
  "trust: 'estimated', paid: true", complete, verifyFull);
forecastMutant('publish a checked amount with missing trust', missingTrust, paidGate,
  'if (own && row.stackBillPaid === true && billsDebit) {', complete, verifyMissing);
forecastMutant('label an unlinked partial as posted', forecastSource, 'if (partial && billsDebit) {',
  'if (partial) {', unlinked, verifyUnlinked);
forecastMutant('report the plan as the posted debit', forecastSource, "amount: Math.abs(row.actual), trust: 'calculated'",
  "amount: row.stackBillAmount, trust: 'calculated'", installments[1], verifyPartial);
const debitProof = 'receipt.account === BILLS_ACCOUNT_ID && receipt.cents > 0';
for (const c of [installments[0], complete]) {
  forecastMutant('treat a Weekly-account debit as money out of Bills', forecastSource, debitProof,
    'receipt.cents > 0', otherMovement(c, 'chequing-b', 1), verifyOtherMovement);
  forecastMutant('treat a credit to Bills as money out of Bills', forecastSource, debitProof,
    'receipt.account === BILLS_ACCOUNT_ID', otherMovement(c, 'chequing-a', -1), verifyOtherMovement);
}
console.log('Bills and Bills account agreement: four before repros, paid and trust controls, receipt account and direction, snapshots and mutants passed.');
