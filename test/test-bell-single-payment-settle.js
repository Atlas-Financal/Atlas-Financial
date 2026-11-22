'use strict';
/* Owner decision (Dale, Nov 21 2026, 8:47 AM PT): a single posted Bills Bell
 * Mobility payment settles that month's Bell bill. Example: the Nov 18 payment
 * (Lunch Money recurring item 3722147) settles November's bell. The plan amount
 * is unchanged.
 *
 * Before: the standing chequing-a Bell rule accepted only the same-day two-leg
 * shape (two-leg-sum + sameAccountSplitLegs), and a lone leg was never a
 * settlement, so bell@2026-11-15 stayed due and was carried into Nov 20 – Dec 3
 * at its plan amount. The repair is singleLegSettles on that one rule.
 *
 * Shapes follow the real Lunch Money row (payee, Chequing A, debit, posting
 * date, recurring_id). Payment amounts are invented, and plan amounts are read
 * from data.json at run time: the repository is public, so no household amount
 * is written or printed here. Provider transaction ids are synthetic.
 *
 * Independent proof of the figure: the expected Bills drop is the bell row's own
 * scheduled amount read straight from data.json, not a number the matcher
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

const BELL_ITEM = 3722147;
const CHEQUING_A = 1001, CHEQUING_B = 1002;
const NOV_PAID = 121.47; // invented
const bell = (id, date, amount, extra) => Object.assign({
  id, account_id: CHEQUING_A, date, amount, is_pending: false, payee: 'Bell Mobility',
  original_name: 'BELL MOBILITY', currency: 'cad', recurring_id: BELL_ITEM,
}, extra || {});
const NOV18 = bell(9401, '2026-11-18', NOV_PAID);

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
const bellKeys = report => (report.representedEventCandidates || [])
  .filter(c => /^bell/.test(c.id))
  .map(c => `${c.id}@${c.date}<-${(c.providerTransactionIds || [c.providerTransactionId]).join('+')}`).sort();
const withoutFlag = () => {
  const rules = clone(identity);
  for (const rule of rules.rules) delete rule.singleLegSettles;
  return rules;
};

console.log('=== the rules: only the standing chequing-a Bell rule opts in; item 3722147 stays unlinked ===');
const flagged = identity.rules.filter(rule => rule.singleLegSettles === true);
ok(flagged.length === 1 && flagged[0].eventId === 'bell' && flagged[0].atlasAccountId === 'chequing-a'
  && flagged[0].settlesWhen === 'two-leg-sum' && flagged[0].sameAccountSplitLegs === true,
  'singleLegSettles is on the standing chequing-a two-leg bell rule only', J(flagged.map(r => r.eventId)));
ok(!identity.rules.some(rule => (rule.lunchMoneyRecurringIds || []).includes(String(BELL_ITEM))
  || (/^bell/.test(String(rule.eventId)) && rule.recurringLinkOf)),
  'no rule names Lunch Money item 3722147, so its schedule and amount stay the plan\'s');
const bellRow = data.plan.bills.find(bill => bill.id === 'bell');
ok(bellRow && bellRow.amount > 0 && bellRow.day === 15 && bellRow.firstDue === '2026-10-15'
  && bellRow.payingAccount === 'chequing-a' && bellRow.frequency === 'monthly',
  'the bell plan row: monthly on the 15th from 2026-10-15, Bills account');

console.log('\n=== the Nov 18 single Bills payment settles November\'s bell ===');
const report = observe([NOV18]);
ok(J(bellKeys(report)) === J(['bell@2026-11-15<-9401']),
  'the Nov 18 Bills payment (recurring 3722147) settles bell@2026-11-15, and only that', J(bellKeys(report)));
const hit = (report.representedEventCandidates || []).find(c => c.id === 'bell');
ok(hit && near(hit.observedAmount, NOV_PAID) && hit.atlasAccountId === 'chequing-a' && hit.direction === 'debit'
  && hit.postingDate === '2026-11-18', 'the settlement records the observed debit on Chequing A',
  J(hit && [hit.id, hit.atlasAccountId, hit.direction, hit.postingDate]));
ok(!(report.ambiguousRepresentedEvents || []).some(g => /^bell/.test(String(g.id || ''))), 'no Bell occurrence is left ambiguous');
ok(J(bellKeys(observe([bell(9401, '2026-11-18', NOV_PAID, { recurring_id: null })]))) === J(['bell@2026-11-15<-9401']),
  'the same payment without a recurring link settles the same occurrence (payee identity)');
ok(J(bellKeys(observe([bell(9402, '2026-11-18', NOV_PAID, { payee: 'BELLMOBILITY', original_name: 'BELLMOBILITY' })]))) === J(['bell@2026-11-15<-9402']),
  'the BELLMOBILITY alias settles the same way');

console.log('\n=== controls (each must settle nothing new) ===');
ok(bellKeys(observe([NOV18], withoutFlag())).length === 0,
  'without singleLegSettles (main before this change) the single payment settles nothing');
ok(bellKeys(observe([bell(9403, '2026-11-18', NOV_PAID, { account_id: CHEQUING_B })])).length === 0,
  'the same payment on Chequing B (not Bills) does not settle Bell');
ok(bellKeys(observe([bell(9404, '2026-11-18', NOV_PAID, { payee: 'Shoppers Drug Mart', original_name: 'SHOPPERS DRUG MART' })])).length === 0,
  'an unrelated payee carrying the Bell recurring link does not settle Bell (the link alone is not identity)');
ok(bellKeys(observe([bell(9405, '2026-11-18', NOV_PAID, { is_pending: true })])).length === 0,
  'a pending Bell payment does not settle');
ok(bellKeys(observe([bell(9406, '2026-11-18', -NOV_PAID)])).length === 0,
  'a Bell credit (refund) does not settle');
ok(bellKeys(observe([bell(9407, '2026-11-18', 60), bell(9408, '2026-11-19', 61.47)])).length === 0,
  'two Bills Bell payments on two dates for one occurrence settle nothing (fail closed)');
ok(J(bellKeys(observe([bell(9409, '2026-11-18', 60), bell(9410, '2026-11-18', 61.47)]))) === J(['bell@2026-11-15<-9409+9410']),
  'the proven same-day two-leg pair still settles one occurrence with both legs');
ok(J(bellKeys(observe([NOV18, bell(9411, '2026-11-18', 20)]))) === J(['bell@2026-11-15<-9401+9411']),
  'a same-day second leg makes it the two-leg pair (both ids, one occurrence), never two settlements');
ok(bellKeys(observe([NOV18, bell(9401, '2026-11-18', 20)])).length === 0,
  'two posted rows sharing one provider id are not a clean single payment and settle nothing');
ok(bellKeys(observe([NOV18, bell(9401, '2026-11-18', 20, { payee: 'Dollarama', original_name: 'DOLLARAMA' })])).length === 0,
  'a provider id shared with a posted non-Bell row is not a clean single payment either (Codex P2 on #1533)');
ok(bellKeys(observe([NOV18, bell(9401, '2026-11-18', 20, { account_id: CHEQUING_B })])).length === 0,
  'the same holds when the other row sharing the id is on another account');
ok(bellKeys(observe([bell(9409, '2026-11-18', 60), bell(9410, '2026-11-18', 61.47),
  bell(9409, '2026-11-18', 20, { payee: 'Dollarama', original_name: 'DOLLARAMA' })])).length === 0,
  'a same-day pair whose first leg shares its id with a posted non-Bell row settles nothing (ChatGPT (Atlas) blocker on #1533)');
ok(bellKeys(observe([bell(9409, '2026-11-18', 60), bell(9410, '2026-11-18', 61.47),
  bell(9410, '2026-11-18', 20, { payee: 'Dollarama', original_name: 'DOLLARAMA' })])).length === 0,
  'the same when the second leg is the shared one, and the clean leg is not taken as a lone settlement');
ok(J(bellKeys(observe([bell(9412, '2026-10-15', 118.06), NOV18]))) === J(['bell@2026-10-15<-9412', 'bell@2026-11-15<-9401']),
  'October and November single payments each settle their own month; ids are not shared');
ok(bellKeys(observe([bell(9413, '2026-09-15', Number(data.plan.bills.find(bill => bill.id === 'bell-sep15-2026').amount))])).length === 0,
  'a single September Bills payment does not settle the September once (that rule keeps its two-leg shape) or reach October');

console.log('\n=== the Nov 20 – Dec 3 period: Bills drop by exactly the bell row ===');
const views = rules => {
  const result = Live.overlayLiveState({ data, report: observe([NOV18], rules) });
  const plan = result.data.plan;
  return F.recommend(plan, plan.opening.asOf, { debts: result.data.debts, periods: [] }).payPeriodViews;
};
const fixedViews = views(identity);
const oldViews = views(withoutFlag());
const pick = (list, start) => list.find(view => view.start === start);
const fixed = pick(fixedViews, '2026-11-20');
const old = pick(oldViews, '2026-11-20');
const DROP = Number(bellRow.amount);
ok(DROP > 0, 'independent expectation: the bell row\'s own scheduled amount, read from data.json');
ok(!!fixed && !!old && fixed.end === '2026-12-03', 'both runs publish the Nov 20 – Dec 3 view');
const rowKeys = view => (view.bills || []).map(row => `${row.id}@${row.date}:${row.amount}`);
const removed = rowKeys(old).filter(k => !rowKeys(fixed).includes(k));
const added = rowKeys(fixed).filter(k => !rowKeys(old).includes(k));
ok(J(removed) === J([`bell@2026-11-15:${bellRow.amount}`]) && added.length === 0,
  'the only bill row that leaves the period is bell@2026-11-15 at its plan amount; no row is added or changed', `${removed.length} removed, ${added.length} added`);
ok(near(old.totalBillsThisPeriod - fixed.totalBillsThisPeriod, DROP) && near(old.periodBillLoad - fixed.periodBillLoad, DROP),
  'Bills for the period drop by exactly the bell row\'s amount');
ok(near(fixed.balanceAfterDeductions - old.balanceAfterDeductions, DROP)
  && near(fixed.plannedPeriodClose - old.plannedPeriodClose, DROP),
  'the balance after deductions and the planned close rise by the same amount (consequence, not a second change)');
ok(['income', 'incomeTotal', 'householdBudget', 'budgetHold', 'opening', 'currentBalance']
  .every(key => J(fixed[key]) === J(old[key])),
  'income, opening, current balance, household budget and budget hold do not move');
const dec = pick(fixedViews, '2026-12-04');
ok(dec && J(dec) === J(pick(oldViews, '2026-12-04'))
  && (dec.bills || []).some(row => row.id === 'bell' && row.date === '2026-12-15' && row.amount === bellRow.amount),
  'Dec 4 – Dec 17 is identical and bell@2026-12-15 is still planned at the plan amount');
ok(fixedViews.filter(view => view.start > '2026-11-20').every(view => J(view) === J(pick(oldViews, view.start))),
  'every later period is identical (future bell occurrences keep the plan amount)');

ok(fs.readFileSync(DATA_PATH, 'utf8') === dataFileBefore, 'data.json is not written');

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
