'use strict';
/* Forecast.householdSubscriptions — "What recurring subscriptions and memberships does the household carry?"
 * `node test/test-subscriptions-page.js`
 *
 * The Subscriptions page that rendered this roster was removed under #822;
 * the file name is kept so the suite identity does not move. Behaviour uses
 * a synthetic fixture with hand-computed expectations; the live data.json is
 * reconciled by independent arithmetic on the published plan.bills rows, not
 * by treating Forecast.householdSubscriptions as the specification.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const round2 = v => Math.round(Number(v) * 100) / 100;
const money2 = n => (n < 0 ? '−$' : '$') + Math.abs(Number(n)).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const longDate = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-CA', { day: 'numeric', month: 'long', year: 'numeric' });
const strip = html => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function independentMonthly(bill) {
  if (!bill || bill.amount == null || !isFinite(Number(bill.amount))) return null;
  if (bill.frequency === 'monthly') return round2(bill.amount);
  if (bill.frequency === 'biweekly') return round2(bill.amount * 26 / 12);
  if (bill.frequency === 'quarterly') return round2(bill.amount / 3);
  if (bill.frequency === 'yearly') return round2(bill.amount / 12);
  return null;
}

function isOccurrenceStub(plan, bill) {
  if (!bill || bill.frequency !== 'once' || !bill.id) return false;
  return ((plan && plan.bills) || []).some(rec =>
    rec && rec.id && rec.frequency !== 'once' && rec.day != null
    && rec.id !== bill.id && bill.id.startsWith(rec.id + '-'));
}

function independentSubscription(bill) {
  if (!bill) return false;
  if (bill.subscription === true) return true;
  if (bill.subscription === false) return false;
  return bill.budgetCategory === 'subscriptions';
}

function independentRoster(plan) {
  return ((plan && plan.bills) || []).filter(bill =>
    bill
    && bill.householdObligation !== false
    && independentSubscription(bill)
    && !isOccurrenceStub(plan, bill));
}

function nextMonthlyDay(day, asOf, firstDue) {
  const [y0, m0] = String(asOf).split('-').map(Number);
  let y = y0;
  let m = m0;
  for (let i = 0; i < 24; i++) {
    const dim = new Date(y, m, 0).getDate();
    const d = Math.min(day, dim);
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (iso >= asOf && (!firstDue || iso >= firstDue)) return iso;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return null;
}

function nextBiweekly(anchor, asOf) {
  const addDays = (iso, n) => {
    const dt = new Date(iso + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
  };
  const diff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  let t = anchor;
  while (diff(asOf, t) > 0) t = addDays(t, -14);
  while (t < asOf) t = addDays(t, 14);
  return t;
}

function nextYearly(month, day, asOf) {
  const [y0] = String(asOf).split('-').map(Number);
  for (let y = y0; y <= y0 + 2; y++) {
    const dim = new Date(y, month, 0).getDate();
    const iso = `${y}-${String(month).padStart(2, '0')}-${String(Math.min(day, dim)).padStart(2, '0')}`;
    if (iso >= asOf) return iso;
  }
  return null;
}

const AS_OF = '2026-08-19';
function fixture() {
  return {
    meta: { asOf: AS_OF },
    plan: {
      windowDays: 91,
      defaults: { scenario: 'expected', targetBuffer: 0, extraDebtMonthly: 0 },
      opening: { asOf: AS_OF },
      startingCash: { breakdown: [{ id: 'chequing-a', label: 'Chequing A', value: 5000 }] },
      income: [],
      obligations: [],
      commitments: [],
      bills: [
        { id: 'gas', label: 'Utility gas', frequency: 'monthly', day: 3, amount: 124,
          confidence: 'confirmed', budgetCategory: 'household', payingAccount: 'chequing-a' },
        { id: 'phone', label: 'Phone', frequency: 'monthly', day: 15, amount: 121,
          confidence: 'estimated', budgetCategory: 'telecom', payingAccount: 'travelvisa', jointCash: false },
        { id: 'stream', label: 'Streaming', frequency: 'monthly', day: 17, amount: 26.87,
          confidence: 'confirmed', budgetCategory: 'subscriptions' },
        { id: 'club', label: 'Club membership', frequency: 'monthly', day: 10, amount: 20,
          confidence: 'confirmed', budgetCategory: 'sport', subscription: true },
        { id: 'not-a-club', label: 'Sports league', frequency: 'monthly', day: 12, amount: 40,
          confidence: 'confirmed', budgetCategory: 'sport', subscription: false },
        { id: 'gym', label: 'Gym membership', frequency: 'biweekly', anchor: '2026-08-14', amount: 11.54,
          confidence: 'confirmed', budgetCategory: 'sport', subscription: true },
        { id: 'annual-soft', label: 'Annual software', frequency: 'yearly', month: 5, day: 8, amount: 120,
          confidence: 'confirmed', budgetCategory: 'subscriptions' },
        { id: 'quarterly-mag', label: 'Quarterly magazine', frequency: 'quarterly', day: 18,
          anchor: '2026-03-18', firstDue: '2026-09-18', amount: 30,
          confidence: 'confirmed', budgetCategory: 'subscriptions' },
        { id: 'stream-aug17-outstanding', label: 'Streaming — August posting unknown',
          frequency: 'once', date: '2026-08-16', amount: 26.87, confidence: 'confirmed',
          budgetCategory: 'subscriptions' },
        { id: 'mystery-sub', label: 'Uncadenced membership', amount: 15, confidence: 'estimated',
          budgetCategory: 'subscriptions' },
        { id: 'external-sub', label: 'Excluded membership', frequency: 'monthly', day: 4, amount: 9,
          confidence: 'confirmed', budgetCategory: 'subscriptions', householdObligation: false },
      ],
    },
  };
}

const CANCELLED_ABSENT = ['canva', 'mailchimp', 'guitar-tabs', 'github', 'pixieset', 'cmaw', 'union-dues'];

console.log('=== 1. Roster is subscriptions, not household bills or occurrence stubs ===');
{
  const fx = fixture();
  const view = F.householdSubscriptions(fx.plan, AS_OF);
  const got = view.subscriptions.map(r => r.id);
  const expectIds = ['stream', 'club', 'gym', 'annual-soft', 'quarterly-mag', 'mystery-sub'];
  ok(expectIds.every(id => got.includes(id)) && got.length === expectIds.length,
    'fixture roster is the subscription-class bills minus stubs and non-obligations',
    got.join(','));
  ok(!got.includes('gas') && !got.includes('phone'),
    'non-subscription household bills stay off the Subscriptions roster');
  ok(got.includes('club'),
    'explicit subscription: true appears even when spending category is sport');
  ok(!got.includes('not-a-club'),
    'explicit subscription: false stays off even when the name says membership');
  ok(got.includes('gym'),
    'a sport-category membership with subscription: true is on the roster');
  ok(!got.includes('stream-aug17-outstanding'),
    'once stub of a recurring sibling is not a second subscription');
  ok(!got.includes('external-sub'),
    'householdObligation: false is not resurrected onto the roster');
}

console.log('\n=== 2. Cadence is preserved; monthly-equivalent is derived only when authorised ===');
{
  const fx = fixture();
  const view = F.householdSubscriptions(fx.plan, AS_OF);
  const byId = Object.fromEntries(view.subscriptions.map(r => [r.id, r]));
  ok(byId.stream.frequency === 'monthly' && byId.stream.frequencyLabel === 'Monthly'
    && near(byId.stream.monthlyEquivalent, 26.87),
    'monthly subscription keeps monthly cadence and uses the amount as monthly equivalent');
  ok(byId['quarterly-mag'].frequency === 'quarterly' && byId['quarterly-mag'].frequencyLabel === 'Every 3 months'
    && near(byId['quarterly-mag'].monthlyEquivalent, round2(30 / 3)),
    'quarterly subscription stays quarterly; monthly equivalent is amount / 3');
  ok(byId.gym.frequency === 'biweekly' && byId.gym.frequencyLabel === 'Every 2 weeks'
    && near(byId.gym.monthlyEquivalent, round2(11.54 * 26 / 12)),
    'biweekly membership stays every 2 weeks; monthly equivalent is amount × 26 / 12');
  ok(byId['annual-soft'].frequency === 'yearly' && byId['annual-soft'].frequencyLabel === 'Yearly'
    && near(byId['annual-soft'].monthlyEquivalent, round2(120 / 12)),
    'yearly subscription stays yearly; monthly equivalent is amount / 12');
  ok(byId['mystery-sub'].frequency == null && byId['mystery-sub'].monthlyEquivalent == null,
    'missing cadence is unknown, not monthly');
}

console.log('\n=== 3. Next dates are the schedule ===');
{
  const fx = fixture();
  const view = F.householdSubscriptions(fx.plan, AS_OF);
  const byId = Object.fromEntries(view.subscriptions.map(r => [r.id, r]));
  ok(byId.stream.nextDate === nextMonthlyDay(17, AS_OF),
    'monthly next date is the next day-of-month on or after as-of', byId.stream.nextDate);
  ok(byId.club.nextDate === nextMonthlyDay(10, AS_OF), 'club next date is 10 September');
  ok(byId.gym.nextDate === nextBiweekly('2026-08-14', AS_OF),
    'biweekly next date walks the 14-day anchor', byId.gym.nextDate);
  ok(byId['annual-soft'].nextDate === nextYearly(5, 8, AS_OF),
    'yearly next date is the next May 8 on or after as-of', byId['annual-soft'].nextDate);
  ok(byId['quarterly-mag'].nextDate === '2026-09-18',
    'quarterly next date is firstDue, not invented as monthly');
  ok(byId['mystery-sub'].nextDate == null, 'missing cadence has no invented next date');
}

console.log('\n=== 4. Monthly total is the sum of known equivalents, not page constants ===');
{
  const fx = fixture();
  const roster = independentRoster(fx.plan);
  const expectedTotal = round2(roster.reduce((s, b) => {
    const m = independentMonthly(b);
    return m == null ? s : s + m;
  }, 0));
  const view = F.householdSubscriptions(fx.plan, AS_OF);
  ok(near(view.monthlyEquivalentTotal, expectedTotal),
    'Forecast total matches independent 26/12, /3, /12 arithmetic',
    `${view.monthlyEquivalentTotal} vs ${expectedTotal}`);
  ok(view.monthlyEquivalentExcludedCount === 1,
    'uncadenced membership is excluded from the total',
    String(view.monthlyEquivalentExcludedCount));
}

console.log('\n=== 6. Live plan.bills reconcile independently ===');
{
  const asOf = live.meta.asOf;
  const roster = independentRoster(live.plan);
  const expectedTotal = roster.reduce((s, b) => {
    const m = independentMonthly(b);
    return m == null ? s : round2(s + m);
  }, 0);
  const view = F.householdSubscriptions(live.plan, asOf);
  const viewIds = view.subscriptions.map(r => r.id);
  ok(roster.every(b => viewIds.includes(b.id)) && viewIds.length === roster.length,
    'live roster is the subscription-class household obligations minus occurrence stubs',
    viewIds.join(','));
  ok(viewIds.includes('fit4less'),
    'live Fit4Less membership appears because subscription: true, not because of its name');
  ok(viewIds.includes('netflix') && viewIds.includes('spotify') && viewIds.includes('ultimate-guitar'),
    'live default budgetCategory: subscriptions rows appear');
  ok(!viewIds.includes('fortis') && !viewIds.includes('noble-garbage') && !viewIds.includes('bell')
    && !viewIds.includes('hydro-due-sep1') && !viewIds.includes('hydro-equal-payment'),
    'live household bills stay off Subscriptions');
  ok(CANCELLED_ABSENT.every(id => !viewIds.includes(id)
    && !((live.plan.bills || []).some(b => b && b.id === id))),
    'cancelled or never-promoted services are absent from plan.bills and are not resurrected');
  const guitar = view.subscriptions.find(r => r.id === 'ultimate-guitar');
  ok(guitar && guitar.frequency === 'yearly' && guitar.frequencyLabel === 'Yearly'
    && guitar.nextDate === nextYearly(5, 8, asOf)
    && near(guitar.monthlyEquivalent, round2(50 / 12)),
    'live Ultimate Guitar stays yearly $50, next May 8, monthly equivalent $4.17');
  const gym = view.subscriptions.find(r => r.id === 'fit4less');
  ok(gym && gym.frequency === 'biweekly' && gym.frequencyLabel === 'Every 2 weeks'
    && gym.nextDate === nextBiweekly('2026-08-14', asOf)
    && near(gym.monthlyEquivalent, round2(11.54 * 26 / 12)),
    'live Fit4Less stays every 2 weeks $11.54, monthly equivalent amount × 26 / 12',
    gym && String(gym.nextDate));
  const dale = view.subscriptions.find(r => r.id === 'chatgpt-plus-dale');
  ok(dale && dale.confidence === 'estimated' && near(dale.amount, 28),
    'live ChatGPT Plus Dale keeps the estimated $28 planning amount');
  ok(near(view.monthlyEquivalentTotal, expectedTotal),
    'live total matches independent arithmetic on plan.bills',
    `${view.monthlyEquivalentTotal} vs ${expectedTotal}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
