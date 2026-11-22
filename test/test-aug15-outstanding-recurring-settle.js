'use strict';
/* ICBC and RESP 15 August outstanding once rows settle again (after #1508).
 *
 * #1508 linked Lunch Money recurring items 3722145 (icbc) and 3722146 (resp) to
 * the MONTHLY rules. Lunch Money also carries those links on the 17 August
 * automatic payments, so the recurring-link veto (a link another rule names
 * outranks this rule's payee rule) stopped the payee-only once rules
 * icbc-aug15-outstanding / resp-aug15-outstanding from ever settling, and
 * Forecast kept reserving both rows' scheduled amounts in every later period. BCAA's August
 * payment carries no link, so bcaa-aug15-outstanding still settled.
 *
 * The repair names recurringLinkOf on the two once rules. Shapes here follow the
 * real Lunch Money rows (payee, original name, Chequing A, debit, posting date,
 * recurring_id). Each posting's amount is the matching plan row's scheduled amount,
 * read from data.json at run time; no household amount is written or printed here.
 * Provider transaction ids are synthetic: the repository is public and fixtures
 * carry no real provider ids.
 *
 * Independent proof of the figure: the expected Bills drop is the two once rows'
 * own scheduled amounts read straight from data.json, not a number the matcher
 * computes. */
const fs = require('fs');
const path = require('path');
const O = require('../scripts/provider-observe.js');
const Live = require('../scripts/live-plan.js');
const F = require('../public/forecast.js');

const ROOT = path.join(__dirname, '..');
const load = file => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const DATA_PATH = path.join(ROOT, 'data.json');
const dataFileBefore = fs.readFileSync(DATA_PATH, 'utf8');
const data = JSON.parse(dataFileBefore);
const fixture = load('docs/connectivity/fixtures/automatic-payment-settlement.json');
const accountMap = load('docs/connectivity/fixtures/provider-account-map.json');
const identity = load('docs/connectivity/transaction-identity.json');
const clone = value => JSON.parse(JSON.stringify(value));
const J = JSON.stringify;
let checks = 0, failures = 0;
const ok = (cond, label, detail) => {
  checks++;
  if (cond) console.log('  PASS  ' + label);
  else { failures++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

const ICBC_ITEM = 3722145, RESP_ITEM = 3722146, BCAA_ITEM = 3722144;
const CHEQUING_A = 1001, CHEQUING_B = 1002;
const tx = (id, date, amount, payee, originalName, recurringId, extra) => Object.assign({
  id, account_id: CHEQUING_A, date, amount, is_pending: false, payee, original_name: originalName,
  currency: 'cad', recurring_id: recurringId == null ? null : recurringId,
}, extra || {});
// The scheduled amount of a plan bill row, from data.json (the posting pays exactly what the row plans).
const billAmount = id => Number(data.plan.bills.find(bill => bill.id === id).amount);
const icbc = (id, date, extra) => tx(id, date, billAmount(date < '2026-09-01' ? 'icbc-aug15-outstanding' : 'icbc'), 'Icbc', 'ICBC INS', ICBC_ITEM, extra);
const resp = (id, date, extra) => tx(id, date, billAmount(date < '2026-09-01' ? 'resp-aug15-outstanding' : 'resp'), 'TD WATERHOUSE I REP', 'TD WATERHOUSE I REP', RESP_ITEM, extra);
const bcaaAug = tx(9301, '2026-08-17', billAmount('bcaa-aug15-outstanding'), 'Bcaa-adv', 'BCAA-AdvAutoIns INS', null);
const ICBC_AUG = icbc(9302, '2026-08-17');
const RESP_AUG = resp(9303, '2026-08-17');
// Monthly postings (Nov 15 fell on a Sunday; the bank posted Monday Nov 16).
const MONTHLY = [
  icbc(9311, '2026-09-15'), resp(9312, '2026-09-15'),
  icbc(9321, '2026-10-15'), resp(9322, '2026-10-15'),
  icbc(9331, '2026-11-16'), resp(9332, '2026-11-16'),
];
const ALL = [bcaaAug, ICBC_AUG, RESP_AUG, ...MONTHLY];

function payload(transactions) {
  const p = clone(fixture);
  p.fetchedAt = '2026-11-21T14:00:00.000Z';
  p.transactionWindow = Object.assign({}, p.transactionWindow, { startDate: '2026-07-24', endDate: '2026-11-21' });
  p.accounts = p.accounts.map(a => Object.assign({}, a,
    { updated_at: '2026-11-21T13:55:00.000Z', balance_last_update: '2026-11-21T13:55:00.000Z' }));
  p.transactions = transactions;
  return p;
}
const observe = (transactions, rules) => O.observe({ provider: 'lunchmoney', payload: payload(transactions),
  accountMap, data, identity: rules || identity });
const keys = report => (report.representedEventCandidates || [])
  .filter(c => /^(icbc|resp|bcaa)/.test(c.id))
  .map(c => `${c.id}@${c.date}<-${c.providerTransactionId}`).sort();
const settled = (report, id, date) => (report.representedEventCandidates || []).some(c => c.id === id && c.date === date);
const withRule = (eventId, change) => {
  const rules = clone(identity);
  for (const rule of rules.rules) if (rule.eventId === eventId) change(rule);
  return rules;
};
const withoutLinkOf = () => {
  const rules = clone(identity);
  for (const rule of rules.rules) delete rule.recurringLinkOf;
  return rules;
};

console.log('=== the rules: two once rules name their series; the item keeps one owner ===');
const ruleFor = id => identity.rules.find(rule => rule.eventId === id);
ok(ruleFor('icbc-aug15-outstanding').recurringLinkOf === 'icbc' && ruleFor('resp-aug15-outstanding').recurringLinkOf === 'resp',
  'icbc-aug15-outstanding names recurringLinkOf icbc; resp-aug15-outstanding names recurringLinkOf resp');
ok(['icbc-aug15-outstanding', 'resp-aug15-outstanding', 'bcaa-aug15-outstanding']
  .every(id => !(ruleFor(id).lunchMoneyRecurringIds || []).length),
  'no once rule names a Lunch Money recurring id, so it is never a second owner of the item');
ok(identity.rules.filter(rule => (rule.lunchMoneyRecurringIds || []).includes(String(ICBC_ITEM))).map(r => r.eventId).join() === 'icbc'
  && identity.rules.filter(rule => (rule.lunchMoneyRecurringIds || []).includes(String(RESP_ITEM))).map(r => r.eventId).join() === 'resp',
  'items 3722145 and 3722146 are still named by exactly one rule each (icbc, resp)');
ok(identity.rules.filter(rule => rule.recurringLinkOf).map(rule => rule.eventId).sort().join() === 'icbc-aug15-outstanding,resp-aug15-outstanding',
  'recurringLinkOf is configured on those two once rules only');

console.log('\n=== the real-shaped August payments settle their once rows ===');
const report = observe(ALL);
const got = keys(report);
const expected = [
  'bcaa-aug15-outstanding@2026-08-16<-9301',
  'icbc-aug15-outstanding@2026-08-16<-9302',
  'resp-aug15-outstanding@2026-08-16<-9303',
  'icbc@2026-09-15<-9311', 'resp@2026-09-15<-9312',
  'icbc@2026-10-15<-9321', 'resp@2026-10-15<-9322',
  'icbc@2026-11-15<-9331', 'resp@2026-11-15<-9332',
].sort();
ok(J(got) === J(expected), 'ICBC and RESP August rows settle from the 17 August linked payments; BCAA still settles; every monthly Sep 15 – Nov 15 occurrence settles from its own posting', J(got));
const ids = (report.representedEventCandidates || []).filter(c => c.providerTransactionId != null)
  .map(c => String(c.providerTransactionId));
ok(new Set(ids).size === ids.length, 'no payment settles two occurrences');
ok(!(report.ambiguousRepresentedEvents || []).some(g => /^(icbc|resp|bcaa)/.test(String(g.id || ''))),
  'no ICBC, RESP or BCAA occurrence is left ambiguous', J((report.ambiguousRepresentedEvents || []).map(g => g.id)));
const aug = (report.representedEventCandidates || []).filter(c => /aug15/.test(c.id) && /^(icbc|resp)/.test(c.id));
ok(aug.length === 2 && aug.every(c => c.postingDate === '2026-08-17' && c.postingDateRelation === 'weekend-next-business-day'
  && c.direction === 'debit'), 'each August row settles on the weekend-to-next-business-day relation, debit',
  J(aug.map(c => [c.id, c.postingDate, c.postingDateRelation, c.direction])));

console.log('\n=== mutants and refusals (each must leave the August row unsettled) ===');
const before = observe(ALL, withoutLinkOf());
ok(!settled(before, 'icbc-aug15-outstanding', '2026-08-16') && !settled(before, 'resp-aug15-outstanding', '2026-08-16')
  && settled(before, 'bcaa-aug15-outstanding', '2026-08-16'),
  'without recurringLinkOf (main before this change) the linked ICBC/RESP August payments settle nothing; unlinked BCAA does', J(keys(before)));
ok(J(keys(before).filter(k => !/aug15/.test(k))) === J(expected.filter(k => !/aug15/.test(k))),
  'the monthly settlements are the same with and without recurringLinkOf');
ok(!settled(observe(ALL, withRule('icbc-aug15-outstanding', r => { r.recurringLinkOf = 'bcaa'; })), 'icbc-aug15-outstanding', '2026-08-16'),
  'recurringLinkOf naming another series keeps the veto');
ok(!settled(observe([icbc(9302, '2026-08-17', { recurring_id: BCAA_ITEM })]), 'icbc-aug15-outstanding', '2026-08-16'),
  'an ICBC payee carrying another bill\'s recurring link (BCAA 3722144) is still vetoed');
ok(!settled(observe([icbc(9302, '2026-08-17', { account_id: CHEQUING_B })]), 'icbc-aug15-outstanding', '2026-08-16'),
  'the series link does not widen the account gate (Chequing B does not settle)');
ok(!settled(observe([icbc(9302, '2026-08-17', { is_pending: true })]), 'icbc-aug15-outstanding', '2026-08-16'),
  'pending evidence does not settle');
ok(!settled(observe([icbc(9302, '2026-08-19')]), 'icbc-aug15-outstanding', '2026-08-16'),
  'a posting outside the weekend-to-next-business-day relation does not settle');
ok(!settled(observe([tx(9302, '2026-08-17', billAmount('icbc-aug15-outstanding'), 'Some Other Payee', 'SOME OTHER PAYEE', ICBC_ITEM)]), 'icbc-aug15-outstanding', '2026-08-16'),
  'the link alone settles nothing: the once rule\'s own payee identity is still required');
ok(!settled(observe([icbc(9311, '2026-09-15')]), 'icbc-aug15-outstanding', '2026-08-16')
  && settled(observe([icbc(9311, '2026-09-15')]), 'icbc', '2026-09-15'),
  'a later monthly payment is the monthly occurrence and never reaches back to the August row');

console.log('\n=== the rejected alternative: naming the ids on the once rules ===');
const named = clone(identity);
for (const rule of named.rules) {
  if (rule.eventId === 'icbc-aug15-outstanding') { delete rule.recurringLinkOf; rule.lunchMoneyRecurringIds = [String(ICBC_ITEM)]; }
  if (rule.eventId === 'resp-aug15-outstanding') { delete rule.recurringLinkOf; rule.lunchMoneyRecurringIds = [String(RESP_ITEM)]; }
}
const item = (rid) => ({ recurringId: String(rid), startDate: '2026-04-15', endDate: null, currency: 'cad', accountRole: 'household-cash',
  granularity: 'month', quantity: 1, anchorDate: '2026-04-15', expectedDates: [], foundTransactionLocalIds: [] });
const block = { status: 'read', items: [item(ICBC_ITEM), item(RESP_ITEM)] };
const schedulesFor = rules => O.recurringBillSchedules(block, rules, data.plan, '2026-11-21', {});
const ownIds = rows => (rows || []).map(row => row.billId).sort().join();
ok(ownIds(schedulesFor(identity.rules)) === 'icbc,resp' && J(schedulesFor(identity.rules)) === J(schedulesFor(withoutLinkOf().rules)),
  'with recurringLinkOf the icbc and resp items still lead their monthly schedules exactly as before', J(schedulesFor(identity.rules)));
ok(ownIds(schedulesFor(named.rules)) === '',
  'naming the ids on the once rules would give each item two owners and refuse both monthly schedules (why that fix was not used)',
  J(schedulesFor(named.rules)));

console.log('\n=== the Nov 20 – Dec 3 period: Bills drop by exactly the two once rows ===');
const viewFor = rules => {
  const result = Live.overlayLiveState({ data, report: observe(ALL, rules) });
  const plan = result.data.plan;
  return F.recommend(plan, plan.opening.asOf, { debts: result.data.debts, periods: [] })
    .payPeriodViews.find(view => view.start === '2026-11-20' && view.end === '2026-12-03');
};
const fixed = viewFor(identity);
const old = viewFor(withoutLinkOf());
const ROW_AMOUNTS = ['icbc-aug15-outstanding', 'resp-aug15-outstanding']
  .map(id => Number(data.plan.bills.find(bill => bill.id === id).amount));
const DROP = ROW_AMOUNTS.reduce((a, b) => a + b, 0);
ok(ROW_AMOUNTS.length === 2 && ROW_AMOUNTS.every(n => n > 0), 'independent expectation: the two once rows\' own scheduled amounts, read from data.json');
ok(!!fixed && !!old, 'both runs publish the Nov 20 – Dec 3 view');
const rowKeys = view => (view.bills || []).map(row => `${row.id}@${row.date}:${row.amount}`);
const removed = rowKeys(old).filter(k => !rowKeys(fixed).includes(k));
const added = rowKeys(fixed).filter(k => !rowKeys(old).includes(k));
const AUG_KEYS = ['icbc-aug15-outstanding', 'resp-aug15-outstanding'].map((id, i) => `${id}@2026-08-16:${ROW_AMOUNTS[i]}`).sort();
ok(J(removed.sort()) === J(AUG_KEYS) && added.length === 0,
  'the only bill rows that leave the period are the two August once rows; no row is added or changed', `${removed.length} removed, ${added.length} added`);
ok(near(old.totalBillsThisPeriod - fixed.totalBillsThisPeriod, DROP) && near(old.periodBillLoad - fixed.periodBillLoad, DROP),
  'Bills for the period drop by exactly the two once rows\' scheduled amounts');
ok(near(fixed.balanceAfterDeductions - old.balanceAfterDeductions, DROP)
  && near(fixed.plannedPeriodClose - old.plannedPeriodClose, DROP),
  'the balance after deductions and the planned close rise by the same amount (consequence, not a second change)');
ok(['income', 'incomeTotal', 'householdBudget', 'budgetHold', 'opening', 'currentBalance']
  .every(key => J(fixed[key]) === J(old[key])),
  'income, opening, current balance, household budget and budget hold do not move');

ok(fs.readFileSync(DATA_PATH, 'utf8') === dataFileBefore, 'data.json is not written');

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
