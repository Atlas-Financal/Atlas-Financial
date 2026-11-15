'use strict';
// A2 (owner-approved audit, 1.0): an early deposit must not be counted twice. A scheduled
// income that posts a day before its date is already inside today's cash; the cash walk
// still counts the occurrence on its scheduled day, which inflated the weekly cap until
// then (invented benefit $500 scheduled Aug 21, posted Aug 20: weekly 1,255 against 1,210
// when it posts on time). The early-deposit guard existed for payroll and the salary pair
// only; it now covers every scheduled income with its own credit identity rule into Bills.
// Required outcome: the early case equals the on-time case, or withholds. Here it withholds
// (the operating plan is unavailable with the existing "occurrence is unresolved" reason),
// so no figure counts the deposit twice. Invented data only, through the real observer and
// overlay path; expectations are the fixture's own literals.
const assert = require('node:assert/strict');
const fx = require('./fixtures/budget-surface-data');
const Live = require('../scripts/live-plan');

let checks = 0;
const ok = (cond, label, detail) => { assert.ok(cond, label + (detail ? ' - ' + detail : '')); checks++; };

// A $500 monthly benefit (id 'benefit') scheduled on `schedDay`, one posting on `postDay`.
// The deposit is already inside the observed Bills balance (1,215 + 500).
function world(schedDay, postDay, { payee = 'Synthetic benefit', rule = true } = {}) {
  const data = fx.canonical();
  data.plan.income.push({ id: 'benefit', label: 'Synthetic benefit', frequency: 'monthly', day: schedDay, amount: 500, confidence: 'confirmed' });
  const payload = fx.payload();
  payload.accounts.find(account => account.id === 1001).balance += 500;
  payload.transactions.push({ id: 93001, account_id: 1001, date: '2026-08-' + String(postDay).padStart(2, '0'), amount: -500,
    currency: 'cad', payee, category_id: 15, is_pending: false, status: 'cleared' });
  const identity = { schema: 'atlas-provider-transaction-identity/v1', rules: [...fx.identity.rules,
    ...(rule ? [{ eventId: 'benefit', payeePattern: 'Synthetic benefit', atlasAccountId: 'chequing-a', direction: 'credit' }] : [])] };
  return Live.fromObservation({ data, payload, accountMap: fx.map, identity }).data;
}
const overlay = data => data.liveOverlay;
const represented = data => (overlay(data).representedEvents || []).map(event => event.id + '@' + event.date);

// On time: the posting is the Aug 20 occurrence, represented once, the plan is live.
const onTime = world(20, 20);
ok(overlay(onTime).applied === true && overlay(onTime).operatingPlan === 'live', 'on-time deposit: the operating plan is live');
ok(represented(onTime).includes('benefit@2026-08-20'), 'on-time deposit: the occurrence is represented once, inside current cash', represented(onTime).join(','));

// Early: posted Aug 20 for the Aug 21 occurrence. It is not represented (the guard never
// attaches a receipt to a future occurrence), so the walk would count Aug 21 again:
// the plan is withheld instead, with the existing unresolved-occurrence reason.
const early = world(21, 20);
ok(overlay(early).applied === true && overlay(early).operatingPlan === 'unavailable',
  'early deposit: the operating plan is withheld, never a cap with the deposit counted twice', String(overlay(early).operatingPlan));
const earlyNote = overlay(early).operatingPlanNote || '';
ok(/^Early deposit to confirm: /.test(earlyNote) && /counts once, as money in/.test(earlyNote) && /scheduled occurrence on 2026-08-21 is unresolved/.test(earlyNote)
    && /ledger links that receipt to its occurrence or Dale approves a mark/.test(earlyNote),
  'early deposit: the note names it (Early deposit to confirm), the occurrence date, that it counts once as money in, and that only a ledger link or an approved mark resolves it', earlyNote.slice(0, 200));
// Never blank: the page prints that note where the plan is withheld.
{
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const F = require('../public/forecast');
  const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
  const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
    document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
  const script = name => fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8');
  vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
  for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), context);
  context.overlay = overlay(early);
  const html = vm.runInContext('currentOperatingUnavailableHtml(null, overlay)', context);
  ok(typeof html === 'string' && html.length > 0 && html.includes('Early deposit to confirm') && html.includes('2026-08-21'),
    'early deposit: the withheld surface prints the reason and the occurrence date, never blank', String(html).slice(0, 160));
}
ok(!represented(early).some(id => id.startsWith('benefit@')), 'early deposit: it is not attached to the future occurrence');

// Controls: nothing else is withheld by the wider guard.
const otherPayee = world(21, 20, { payee: 'Synthetic refund' });
ok(overlay(otherPayee).operatingPlan === 'live', 'a credit that does not match the income identity rule withholds nothing');
const noRule = world(21, 20, { rule: false });
ok(overlay(noRule).operatingPlan === 'live', 'an income with no identity rule is left to its own evidence (unchanged)');
const previous = world(14, 14);
ok(overlay(previous).operatingPlan === 'live', 'a deposit on its own earlier scheduled day withholds nothing');
// Late postings are not early ones (blocker on #1147): income has no after-the-day tolerance, so
// a deposit one day late, or a Friday occurrence landing Monday, is unclaimed. It is that
// occurrence's late posting, never an early one for NEXT month's, so the plan stays live (the
// same as it was before the guard was widened; byte-identity with main for these worlds was
// checked outside this test, by hashing the served document on both trees).
for (const [label, sched, post] of [['one day late (scheduled Aug 18, posted Aug 19)', 18, 19], ['Friday occurrence landing Monday (Aug 14 -> Aug 17)', 14, 17]]) {
  const late = world(sched, post);
  ok(overlay(late).applied === true && overlay(late).operatingPlan === 'live', label + ': the operating plan stays live', String(overlay(late).operatingPlan));
  ok(!(late.liveOverlay.currentPeriodActuals && late.liveOverlay.currentPeriodActuals.incomeReconciliation),
    label + ': no unresolved-occurrence hold on next month');
}

// The occurrence just before the credit decides (second blocker on #1147: the first repair
// looked at EVERY earlier occurrence, so one old unposted occurrence in the window switched the
// early-deposit hold off for every later credit). A biweekly benefit, observed Aug 27 (the
// Aug 14 occurrence is after the Aug 13 opening, so its on-time posting is claimed and
// represented). An extra credit on Aug 27 for the Aug 28 occurrence is the NEXT one arriving
// early and must withhold, whatever older occurrences did; when the previous occurrence was
// never posted, a credit after it is its late posting and stays live.
function biweekly({ anchor, postDates, windowStart = '2026-07-20' }) {
  const asOf = '2026-08-27';
  const data = fx.canonical();
  data.plan.income.push({ id: 'benefit', label: 'Synthetic benefit', frequency: 'biweekly', anchor, amount: 500, confidence: 'confirmed' });
  const payload = fx.payload();
  payload.fetchedAt = asOf + 'T18:00:00.000Z';
  payload.transactionWindow.startDate = windowStart;
  payload.transactionWindow.endDate = asOf;
  for (const account of payload.accounts) { account.updated_at = asOf + 'T17:55:00.000Z'; account.balance_last_update = asOf + 'T17:55:00.000Z'; }
  payload.accounts.find(account => account.id === 1001).balance += 500 * postDates.length;
  let id = 93100;
  for (const date of postDates) {
    payload.transactions.push({ id: ++id, account_id: 1001, date, amount: -500, currency: 'cad', payee: 'Synthetic benefit',
      category_id: 15, is_pending: false, status: 'cleared' });
  }
  const identity = { schema: 'atlas-provider-transaction-identity/v1', rules: [...fx.identity.rules,
    { eventId: 'benefit', payeePattern: 'Synthetic benefit', atlasAccountId: 'chequing-a', direction: 'credit' }] };
  return Live.fromObservation({ data, payload, accountMap: fx.map, identity }).data;
}
{
  // Window from Aug 1: only Aug 14 (claimed) and Aug 28 are in play. The common recurring case.
  const claimedEarly = biweekly({ anchor: '2026-08-14', postDates: ['2026-08-14', '2026-08-27'], windowStart: '2026-08-01' });
  ok(represented(claimedEarly).includes('benefit@2026-08-14'), 'control: the Aug 14 occurrence is claimed by its own on-time posting', represented(claimedEarly).join(','));
  ok(overlay(claimedEarly).operatingPlan === 'unavailable',
    'claimed previous occurrence + an early credit for the next: withheld', String(overlay(claimedEarly).operatingPlan));
  const onTimeOnly = biweekly({ anchor: '2026-08-14', postDates: ['2026-08-14'], windowStart: '2026-08-01' });
  ok(overlay(onTimeOnly).operatingPlan === 'live', 'control: the on-time posting alone stays live', String(overlay(onTimeOnly).operatingPlan));
  // Window from Jul 20 also holds the Jul 31 occurrence, which nothing claims. It is older than the
  // previous occurrence and must not switch the hold off (fails on the first repair).
  const oldUnclaimed = biweekly({ anchor: '2026-08-14', postDates: ['2026-08-14', '2026-08-27'] });
  ok(!represented(oldUnclaimed).includes('benefit@2026-07-31') && represented(oldUnclaimed).includes('benefit@2026-08-14'),
    'control: Jul 31 is unclaimed and Aug 14 is claimed', represented(oldUnclaimed).join(','));
  ok(overlay(oldUnclaimed).operatingPlan === 'unavailable',
    'an older unclaimed occurrence in the window does not turn the early-deposit hold off', String(overlay(oldUnclaimed).operatingPlan));
  // The previous occurrence itself never posted: a credit after it is its late posting.
  const lateRecurring = biweekly({ anchor: '2026-08-14', postDates: ['2026-08-16'] });
  ok(overlay(lateRecurring).operatingPlan === 'live', 'recurring income posted two days late stays live', String(overlay(lateRecurring).operatingPlan));
}

// The occurrence just before the credit is read from the income's own schedule, also when it is
// dated BEFORE the window starts (third blocker on #1147: a late deposit for an occurrence just
// before the window start was withheld, because nothing in the window showed a previous occurrence).
// The window is Aug 13-20, observed Aug 20. Each of these is a LATE posting of an occurrence dated
// before the window, so the plan stays live (as on main, where the cap is unchanged: the guard
// widening must not withhold them). The monthly worlds above keep an early case withholding
// (Jul 21 is also before the window; the credit sits one day before Aug 21, a month after Jul 21).
for (const [label, sched, post] of [['Aug 12 -> posted Aug 13', 12, 13], ['Aug 12 -> posted Aug 14', 12, 14],
  ['Aug 11 -> posted Aug 14', 11, 14], ['Aug 10 -> posted Aug 13', 10, 13]]) {
  const edge = world(sched, post);
  ok(overlay(edge).applied === true && overlay(edge).operatingPlan === 'live',
    'window edge, ' + label + ': a late posting stays live', String(overlay(edge).operatingPlan));
  ok(!(edge.liveOverlay.currentPeriodActuals && edge.liveOverlay.currentPeriodActuals.incomeReconciliation),
    'window edge, ' + label + ': no unresolved-occurrence hold');
}
// Early postings next to the window edge keep withholding: the credit is nearer the NEXT occurrence.
for (const [label, sched, post] of [['Aug 21 -> posted Aug 20', 21, 20], ['Aug 22 -> posted Aug 19', 22, 19]]) {
  const edge = world(sched, post);
  ok(overlay(edge).operatingPlan === 'unavailable', 'window edge, early ' + label + ': still withheld', String(overlay(edge).operatingPlan));
}
// Biweekly edge, observed Aug 20 with the same window. Occurrence Aug 12 (before the window), next Aug 26.
function biweeklyEdge(anchor, post) {
  const data = fx.canonical();
  data.plan.income.push({ id: 'benefit', label: 'Synthetic benefit', frequency: 'biweekly', anchor, amount: 500, confidence: 'confirmed' });
  const payload = fx.payload();
  payload.accounts.find(account => account.id === 1001).balance += 500;
  payload.transactions.push({ id: 93201, account_id: 1001, date: post, amount: -500, currency: 'cad', payee: 'Synthetic benefit',
    category_id: 15, is_pending: false, status: 'cleared' });
  const identity = { schema: 'atlas-provider-transaction-identity/v1', rules: [...fx.identity.rules,
    { eventId: 'benefit', payeePattern: 'Synthetic benefit', atlasAccountId: 'chequing-a', direction: 'credit' }] };
  return Live.fromObservation({ data, payload, accountMap: fx.map, identity }).data;
}
const biLate = biweeklyEdge('2026-08-12', '2026-08-14');
ok(overlay(biLate).operatingPlan === 'live', 'biweekly window edge: Aug 12 occurrence posted Aug 14 (12 days before Aug 26) is late and stays live', String(overlay(biLate).operatingPlan));
const biEarly = biweeklyEdge('2026-08-07', '2026-08-20');
ok(overlay(biEarly).operatingPlan === 'unavailable', 'biweekly window edge: a credit one day before the Aug 21 occurrence, 13 days after Aug 7, is held', String(overlay(biEarly).operatingPlan));
const biTie = biweeklyEdge('2026-08-12', '2026-08-19');
ok(overlay(biTie).operatingPlan === 'unavailable', 'biweekly window edge: a credit exactly between Aug 12 and Aug 26 cannot be proven late and is held', String(overlay(biTie).operatingPlan));

console.log(`PASS early deposit counted once for every scheduled income: ${checks} checks`);
