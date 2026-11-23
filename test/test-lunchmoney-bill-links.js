'use strict';
/* Owner-provided recurring ids (Dale, lead session 2026-11-21): each linked bill or card row takes its schedule from its
 * reviewed Lunch Money item (schedule only; amounts stay the plan's), and the Triangle TD payment runs seven months.
 * Invented recurring items only (anchors chosen here, not Lunch Money's); dates only, no household amount is printed. */
const assert = require('node:assert/strict');
const O = require('../scripts/provider-observe.js');
const F = require('../public/forecast.js');
const data = require('../data.json');
const identity = require('../docs/connectivity/transaction-identity.json');
let checks = 0, failures = 0;
const ok = (cond, label, detail) => { checks++; if (cond) console.log('  PASS  ' + label); else { failures++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); } };
const J = JSON.stringify;
const LINKS = { shaw: '3722143', bcaa: '3722144', icbc: '3722145', resp: '3722146', netflix: '3722150', 'icloud-storage': '3722153',
  'google-storage-100gb': '3722157', 'chatgpt-plus-dale': '3722348', 'youtube-premium': '3709406', 'noble-garbage': '3722207',
  fit4less: '3722395', 'tdcc-auto17': '3722415', 'triangle-td3': '3722506', microsoft: '3722390', 'teamsnap-plus': '3722391', 'muse-meta': '3722358', 'mbna-auto30': '3709492', 'crave-standard-ads': '3722235',
  'paramount-plus': '3722236', stacktv: '3722237', 'prime-video-ad-free': '3722299',
  // Lead 2026-11-23: fortis is its reviewed item 3709340 (Bills, monthly from 2026-12-01).
  fortis: '3709340' };
// Invented items: monthly on the 5th (a day no linked row uses today), quarterly, biweekly as the row's cadence needs.
const invented = (id, rid) => {
  const row = data.plan.bills.find(b => b.id === id) || data.plan.obligations.find(o => o.id === id);
  const base = { recurringId: rid, startDate: '2026-10-01', endDate: null, currency: 'cad', accountRole: 'household-cash', expectedDates: [], foundTransactionLocalIds: [] };
  if (row.frequency === 'quarterly') return { ...base, granularity: 'month', quantity: 3, anchorDate: '2026-09-05' };
  if (row.frequency === 'biweekly') return { ...base, granularity: 'week', quantity: 2, anchorDate: '2026-11-13' };
  // Amazon's card row: an item on its own day (the 30th) links; a card day never moves later than its plan day.
  if (id === 'mbna-auto30') return { ...base, granularity: 'month', quantity: 1, anchorDate: '2026-10-30' };
  // The TD card's fixed autopay row (successor from Dec 17): an item on its own day (the 17th) links.
  if (id === 'tdcc-auto17') return { ...base, granularity: 'month', quantity: 1, anchorDate: '2026-11-17' };
  return { ...base, granularity: 'month', quantity: 1, anchorDate: '2026-11-05' };
};
const review = rules => O.recurringBillSchedules({ status: 'read', items: Object.entries(LINKS).map(([id, rid]) => invented(id, rid)) },
  rules, data.plan, '2026-11-21', {});

console.log('1. The committed rules name each owner-provided id exactly once');
const owners = {};
for (const r of identity.rules) for (const x of r.lunchMoneyRecurringIds || []) owners[x] = (owners[x] || []).concat(r.eventId);
for (const [id, rid] of Object.entries(LINKS)) ok(J(owners[rid]) === J([id]), `${id} → ${rid}, one rule`, J(owners[rid]));
for (const rid of ['3722173', '3722165', '3722147', '3722158', '3722163', '3722170', '3722167'])
  ok(!owners[rid], `${rid} is not linked (see the merge card)`);

console.log('2. An invented item moves each linked row; nothing else moves');
const got = review(identity.rules);
const byId = Object.fromEntries(got.map(s => [s.billId || s.obligationId, s]));
for (const id of ['shaw', 'bcaa', 'icbc', 'resp', 'netflix', 'icloud-storage', 'google-storage-100gb', 'chatgpt-plus-dale', 'youtube-premium', 'microsoft', 'teamsnap-plus', 'muse-meta', 'crave-standard-ads', 'paramount-plus', 'stacktv', 'prime-video-ad-free', 'fortis'])
  ok(byId[id] && byId[id].timing.frequency === 'monthly' && byId[id].timing.day === 5, `${id}: monthly on the invented 5th`, J(byId[id]));
ok(byId['noble-garbage'] && byId['noble-garbage'].timing.frequency === 'quarterly' && byId['noble-garbage'].timing.day === 5,
  'noble-garbage: quarterly on the 5th', J(byId['noble-garbage']));
ok(byId.fit4less && byId.fit4less.timing.frequency === 'biweekly' && byId.fit4less.timing.anchor === '2026-11-13',
  'fit4less: every two weeks from the invented Nov 13', J(byId.fit4less));
ok(byId['mbna-auto30'] && byId['mbna-auto30'].fields.day === 30, 'mbna-auto30 (card row): the item on the 30th links (schedule source lunchmoney-recurring)', J(byId['mbna-auto30']));
ok(byId['tdcc-auto17'] && byId['tdcc-auto17'].fields.day === 17 && !byId['tdcc-auto17'].fields.timingBefore,
  'tdcc-auto17 (card row): the item on the 17th links, its own day', J(byId['tdcc-auto17']));
{ // An earlier-day item cannot move the successor before its first payment (the Dec 17 occurrence would be lost): plan dates stand.
  const early = { ...invented('tdcc-auto17', LINKS['tdcc-auto17']), anchorDate: '2026-11-05' };
  ok(O.recurringBillSchedules({ status: 'read', items: [early] }, identity.rules, data.plan, '2026-11-21', {}).length === 0,
    'tdcc-auto17: an invented item on the 5th is refused (plan day stands)'); }
ok(!byId.tdcc, 'tdcc (ended Nov 17): no longer linked, takes no schedule');
ok(!byId['triangle-td3'], 'triangle-td3: an open-ended invented item cannot move a dated card row past its statement (plan dates stand)');
ok(Object.keys(byId).every(id => LINKS[id]), 'only linked rows have a schedule', J(Object.keys(byId)));

console.log('3. Removing the ids restores the plan');
const unlinked = identity.rules.map(r => { const c = { ...r }; if (Object.values(LINKS).some(x => (c.lunchMoneyRecurringIds || []).includes(x))) delete c.lunchMoneyRecurringIds; return c; });
ok(review(unlinked).length === 0, 'with the ids removed, no row takes a schedule');

console.log('4. The Triangle TD payment: seven months on the 3rd, then the minimum on the 8th from July');
const tri = F.expandEvents({ ...data.plan, opening: { ...data.plan.opening, representedEvents: [] } }, '2026-11-21', '2027-09-30', {})
  .filter(e => e.kind === 'obligation' && /^triangle/.test(e.id)).map(e => [e.date, e.id]);
const td3 = tri.filter(e => e[1] === 'triangle-td3').map(e => e[0]);
ok(J(td3) === J(['2026-12-03', '2027-01-03', '2027-02-03', '2027-03-03', '2027-04-03', '2027-05-03', '2027-06-03']),
  'seven payments, Dec 3 to Jun 3', J(td3));
const d8 = tri.filter(e => e[1] === 'triangle-day8').map(e => e[0]);
ok(J(d8) === J(['2027-07-08', '2027-08-08', '2027-09-08']), 'the fixed-interest minimum returns Jul 8', J(d8));
const months = {}; for (const [d] of tri) months[d.slice(0, 7)] = (months[d.slice(0, 7)] || 0) + 1;
ok(Object.values(months).every(n => n === 1), 'one Triangle payment per month', J(months));
const row = data.plan.obligations.find(o => o.id === 'triangle-td3');
ok(F.expandEvents({ ...data.plan, opening: { ...data.plan.opening, representedEvents: [] } }, '2026-11-21', '2027-06-30', {})
  .filter(e => e.id === 'triangle-td3').every(e => Math.abs(e.amount) === row.amount), 'each payment is the dated row\'s amount');
console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
