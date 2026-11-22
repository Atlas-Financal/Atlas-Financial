'use strict';
/* Owner facts 2026-11-21 (Dale, his two TD card statements, read from his banking app; lead dispatch).
 *
 * TD Cash Back Visa: the minimum is due on the 4th. `cashback` ends at its 2026-11-01 occurrence (lastDue) and the
 * successor `cashback-day4` carries the schedule on from 2026-12-04, whose statement minimum is owner-confirmed;
 * later months stay estimated at the existing level.
 * The same Cash Back statement shows a last payment on 2026-11-09 and no past-due amount, so the 2026-11-01 minimum is
 * represented effective 2026-11-09 (lead, 2026-11-21). Its payment (the ledger's 2026-11-06 Bills transfer) is recorded on that
 * occurrence's sentPayments, so the card-minimum category path treats it as consumed and it cannot also settle
 * cashback-day4's 2026-12-04 minimum (ATLAS REVIEWER 2, #1509). Section 5 proves that on an invented ledger.
 * TD Travel Visa: the statement balance is paid (a 2026-11-19 payment), so there are no arrears. The 2026-08-26 to
 * 2026-11-26 minimums are represented effective 2026-11-19 by owner confirmation, and the 11-26 statement minimum is
 * owner-confirmed; later minimums stay estimated.
 *
 * Pinned from the household's own dated rows in data.json, on the opening the live page uses (the committed opening
 * as priorAsOf, advanced to 2026-11-21). Expected amounts are read from the committed rows, never written here, and
 * no household figure is printed. Dates and the period boundaries are worked by hand.
 *   node test/test-td-card-statement-facts.js
 */
const F = require('../public/forecast.js');
const Snap = require('../scripts/figures-snapshot.js');
const identity = require('../docs/connectivity/transaction-identity.json');

let checks = 0, failures = 0;
const ok = (cond, label, detail) => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? ' — ' + detail : ''}`);
};

const AS_OF = '2026-11-21';
const { data, periods } = Snap.loadCanonicalInputs();
const obligation = id => data.plan.obligations.find(o => o.id === id);
// The live page's opening: the committed opening becomes priorAsOf, advanced to AS_OF.
function livePlan(edit) {
  const plan = JSON.parse(JSON.stringify(data.plan));
  plan.opening = { ...plan.opening, priorAsOf: plan.opening.asOf, asOf: AS_OF };
  if (edit) edit(plan);
  return plan;
}
const views = plan => F.recommend(plan, AS_OF, Snap.pageOptions(data, periods)).payPeriodViews;
const period = (vs, start) => vs.find(v => v.start === start);
const rows = (v, re) => ((v && v.bills) || []).filter(r => re.test(r.id));
const cents = n => Math.round(n * 100);

console.log('1. The committed rows');
const cashback = obligation('cashback'), day4 = obligation('cashback-day4'), travel = obligation('travel');
ok(cashback && cashback.lastDue === '2026-11-01' && cashback.day === 1, 'cashback ends at its 2026-11-01 occurrence (lastDue)');
ok(day4 && day4.debtId === 'cashback' && day4.effect === 'payment' && day4.day === 4 && day4.firstDue === '2026-12-04'
  && day4.payingAccount === cashback.payingAccount, 'cashback-day4: the same card, due on the 4th from 2026-12-04, paid from the same account');
ok(day4 && day4.confidence === 'estimated' && day4.amount === cashback.amount,
  'cashback-day4: later minimums stay estimated at the existing level');
const dec4 = day4 && (day4.statementOccurrences || []).find(o => o.scheduledDate === '2026-12-04');
ok(dec4 && dec4.dueDate === '2026-12-04' && dec4.confidence === 'confirmed' && dec4.currency === 'cad' && dec4.minimum > 0,
  'cashback-day4: the 2026-12-04 statement minimum is owner-confirmed');
const nov26 = travel && (travel.statementOccurrences || []).find(o => o.scheduledDate === '2026-11-26');
ok(nov26 && nov26.dueDate === '2026-11-26' && nov26.confidence === 'confirmed' && nov26.minimum > 0,
  'travel: the 2026-11-26 statement minimum is owner-confirmed');
ok(travel && travel.confidence === 'estimated' && travel.day === 26 && !travel.sentPayments,
  'travel: later minimums stay estimated, and no payment amount is recorded');
const TRAVEL_DATES = ['2026-08-26', '2026-09-26', '2026-10-26', '2026-11-26'];
const travelRep = (data.plan.opening.representedEvents || []).filter(e => e.id === 'travel');
ok(JSON.stringify(travelRep.map(e => e.date)) === JSON.stringify(TRAVEL_DATES)
  && travelRep.every(e => e.effectiveAsOf === '2026-11-19'),
  'travel: the four minimums are represented effective 2026-11-19 (the covering payment), not before');
const cbRep = (data.plan.opening.representedEvents || []).filter(e => e.id === 'cashback' && e.date === '2026-11-01');
ok(cbRep.length === 1 && cbRep[0].effectiveAsOf === '2026-11-09',
  'cashback: the 2026-11-01 minimum is represented effective 2026-11-09 (the last payment)');
const novSent = (cashback.sentPayments || []).filter(p => p.scheduledDate === '2026-11-01');
ok(novSent.length === 1 && novSent[0].confirmed === true && novSent[0].pending === false && novSent[0].intent === 'minimum'
  && novSent[0].fundingAccountId === cashback.payingAccount && novSent[0].postedOn === '2026-11-06' && novSent[0].amount > 0
  && novSent[0].currency === 'cad' && novSent[0].cashIncludedAsOf === '2026-11-09'
  && !(day4.sentPayments || []).length,
  'cashback: its 2026-11-01 payment is recorded once, on that occurrence (posted 2026-11-06 from the paying account), and on no other row');
const strip = rule => { const { eventId, ...rest } = rule; return JSON.stringify(rest); };
const base = identity.rules.filter(r => r.eventId === 'cashback').map(strip);
ok(base.length > 0 && JSON.stringify(identity.rules.filter(r => r.eventId === 'cashback-day4').map(strip)) === JSON.stringify(base),
  "cashback-day4: its payment-alias rules are exact copies of cashback's, which are kept for history");

console.log('2. The live page on ' + AS_OF + ' (pay periods Nov 20-Dec 3 and Dec 4-17)');
const vs = views(livePlan());
const now = period(vs, '2026-11-20'), next = period(vs, '2026-12-04');
ok(now && now.end === '2026-12-03' && next && next.end === '2026-12-17', 'the two periods are Nov 20-Dec 3 and Dec 4-17');
ok(rows(now, /^cashback/).length === 0, 'acceptance 1: no Cash Back minimum in Nov 20-Dec 3');
const moved = rows(next, /^cashback/);
ok(moved.length === 1 && moved[0].id === 'cashback-day4' && moved[0].date === '2026-12-04',
  'acceptance 1: the Cash Back minimum is in Dec 4-17, on 2026-12-04');
ok(moved.length === 1 && cents(moved[0].amount) === cents(dec4.minimum) && moved[0].confidence === 'confirmed',
  'acceptance 1: at the statement amount, confirmed');
ok(moved.length === 1 && moved[0].settlement === 'upcoming' && moved[0].status === 'still due', 'acceptance 1: and still due (nothing paid yet)');
const later = vs.flatMap(v => rows(v, /^cashback/)).filter(r => r.date > '2026-12-17' && r.date < '2027-03-01');
ok(later.length === 2 && later.every(r => r.id === 'cashback-day4' && r.date.slice(8) === '04' && r.confidence === 'estimated'
  && cents(r.amount) === cents(day4.amount)), 'later months: on the 4th, estimated at the existing level',
  JSON.stringify(later.map(r => [r.id, r.date, r.confidence])));
const shown = vs.filter(v => v.start <= '2026-12-03').flatMap(v => rows(v, /^travel$/));
ok(JSON.stringify(shown.map(r => r.date)) === JSON.stringify(TRAVEL_DATES.slice(1)) && shown.every(r => TRAVEL_DATES.includes(r.date) && r.settlement === 'represented' && r.status === 'PAID'),
  'acceptance 2: the three Travel minimums on the page through Nov 26 (Sep, Oct, Nov) all read paid (represented)',
  JSON.stringify(shown.map(r => [r.date, r.settlement])));
const nov = rows(now, /^travel$/)[0];
ok(nov && nov.date === '2026-11-26' && cents(nov.amount) === cents(nov26.minimum) && nov.confidence === 'confirmed',
  'the Nov 26 Travel row is the confirmed statement minimum, paid');
const dec = vs.filter(v => v.start > '2026-12-17' && v.start < '2027-01-01').flatMap(v => rows(v, /^travel$/));
ok(dec.length === 1 && dec[0].date === '2026-12-26' && dec[0].confidence === 'estimated' && dec[0].settlement === 'upcoming',
  'later Travel minimums stay estimated and still due (Dec 26)');

console.log('3. The cash walk from ' + AS_OF);
const walk = F.expandEvents(livePlan(), AS_OF, '2026-12-31', {}).filter(e => e.kind === 'obligation');
ok(!walk.some(e => e.id === 'travel' && e.date === '2026-11-26'), 'the satisfied Nov 26 Travel minimum is not paid again');
ok(walk.some(e => e.id === 'travel' && e.date === '2026-12-26'), 'the Dec 26 Travel minimum still leaves cash');
const out = walk.filter(e => /^cashback/.test(e.id) && e.date >= AS_OF);
ok(out.length === 1 && out[0].id === 'cashback-day4' && out[0].date === '2026-12-04',
  'the only Cash Back minimum due from today to year end is 2026-12-04 (no Dec 1)', JSON.stringify(out.map(e => [e.id, e.date])));
ok(!walk.some(e => /^cashback/.test(e.id) && e.date < AS_OF), 'the paid 2026-11-01 Cash Back minimum is no longer carried');
const novCb = rows(period(vs, '2026-10-23'), /^cashback$/)[0];
ok(novCb && novCb.date === '2026-11-01' && novCb.settlement === 'represented' && novCb.status === 'PAID',
  'the 2026-11-01 Cash Back minimum (Oct 23-Nov 5) reads paid (represented)');

console.log('4. Each change does the work (removed, the old state comes back)');
{
  const noRep = views(livePlan(p => { p.opening.representedEvents = p.opening.representedEvents.filter(e => e.id !== 'travel'); }));
  const oct = rows(period(noRep, '2026-10-23'), /^travel$/)[0];
  ok(oct && oct.settlement === 'unverified', 'without the represented entries the Oct 26 Travel minimum reads unverified again');
  const noCb = livePlan(p => { p.opening.representedEvents = p.opening.representedEvents.filter(e => !(e.id === 'cashback' && e.date === '2026-11-01')); });
  const historicalCb = rows(period(views(noCb), '2026-10-23'), /^cashback$/).find(r => r.date === '2026-11-01');
  ok(historicalCb && historicalCb.settlement === 'unverified',
    'without its represented entry the Nov 1 minimum is unverified in its own period');
  ok(!F.expandEvents(noCb, AS_OF, '2026-12-31', {}).some(e => e.id === 'cashback' && e.date === '2026-11-01'),
    'the unverified Nov 1 minimum stays out of the later cash walk');
  const noEnd = views(livePlan(p => { delete p.obligations.find(o => o.id === 'cashback').lastDue; }));
  ok(rows(period(noEnd, '2026-11-20'), /^cashback$/).some(r => r.date === '2026-12-01'),
    'without lastDue a Dec 1 Cash Back minimum returns to Nov 20-Dec 3 (beside the Dec 4 one)');
  const early = views(livePlan(p => { p.opening.representedEvents.filter(e => e.id === 'travel').forEach(e => { e.effectiveAsOf = '2026-11-22'; }); }));
  ok(rows(period(early, '2026-10-23'), /^travel$/)[0].settlement === 'unverified',
    'an effective date after the opening does not settle them (the 2026-11-19 date is what qualifies them)');
}

console.log('5. One payment settles one minimum (invented ledger, through the live path)');
{
  // Invented: a $49.37 categorized Cash Back payment from Bills posted 2035-11-09, inside cashback-day4's 2035-12-04
  // window (close day 7) and after cashback's 2035-11-01 window. The rows are shaped as in data.json.
  const Live = require('../scripts/live-plan');
  const Category = require('../scripts/card-minimum-category');
  const source = require('./fixtures/card-backfill-data');
  const NOW = '2035-11-21';
  const world = recorded => {
    const x = source('cashback', 'cashback');
    const name = Object.keys(Category.CATEGORIES).find(k => Category.CATEGORIES[k] === 'cashback');
    x.data.meta.asOf = x.data.plan.opening.asOf = '2035-11-01';
    x.data.plan.opening.representedEvents = [{ id: 'cashback', date: '2035-11-01', effectiveAsOf: '2035-11-09' }];
    x.data.plan.income[0].anchor = '2035-11-01'; x.data.plan.income[0].amount = 0;
    x.data.plan.budget = { categories: [] };
    x.data.debts[0].statementCloseDay = 7;
    const old = { id: 'cashback', debtId: 'cashback', effect: 'payment', frequency: 'monthly', day: 1, firstDue: '2035-10-01',
      lastDue: '2035-11-01', payingAccount: 'chequing-a', amount: 41.13, confidence: 'estimated' };
    if (recorded) old.sentPayments = [{ scheduledDate: '2035-11-01', confirmed: true, intent: 'minimum', debitId: 'cashback-2035-11-bank-sent',
      postedOn: '2035-11-09', amount: 49.37, currency: 'cad', fundingAccountId: 'chequing-a', pending: false, cashIncludedAsOf: '2035-11-09' }];
    x.data.plan.obligations = [old, { id: 'cashback-day4', debtId: 'cashback', effect: 'payment', frequency: 'monthly', day: 4,
      firstDue: '2035-12-04', payingAccount: 'chequing-a', amount: 41.13, confidence: 'estimated',
      statementOccurrences: [{ scheduledDate: '2035-12-04', dueDate: '2035-12-04', minimum: 43.19, currency: 'cad', confidence: 'confirmed' }] }];
    x.data.plan.startingCash.breakdown[0].value = 1000; x.data.debts[0].balance = 800;
    x.payload.accounts[0].balance = 950.63; x.payload.accounts[3].balance = 750.63;
    x.payload.accounts.forEach(a => { a.updated_at = NOW + 'T17:00:00Z'; a.balance_last_update = NOW + 'T17:00:00Z'; });
    x.payload.fetchedAt = NOW + 'T18:00:00Z';
    x.payload.transactionWindow = { startDate: '2035-11-01', endDate: NOW, complete: true, hasMore: false, truncated: false };
    x.payload.categories = [{ id: 9001, name, is_income: false, is_group: false, exclude_from_totals: true, exclude_from_budget: true }];
    x.payload.transactions = [{ id: 98001, account_id: 3001, date: '2035-11-09', amount: 49.37, currency: 'cad',
      payee: 'TFR-TO C/C', category_id: 9001, is_pending: false, status: 'reviewed' }];
    x.asOf = NOW;
    return x;
  };
  const run = recorded => {
    const live = Live.fromObservation(world(recorded)), plan = live.data.plan;
    const settled = ((plan.cardMinimumCategoryEvidence || {}).payments || []).map(p => p.id + '@' + p.scheduledDate);
    const walk = F.expandEvents(plan, NOW, '2035-12-31', {}).filter(e => /^cashback/.test(e.id)).map(e => e.id + '@' + e.date);
    const shown = F.recommend(plan, NOW, {}).payPeriodViews.flatMap(v => rows(v, /^cashback/));
    return { applied: !!(live.data.liveOverlay && live.data.liveOverlay.applied), settled, walk,
      nov: shown.find(r => r.date === '2035-11-01'), dec: shown.find(r => r.date === '2035-12-04') };
  };
  const fixed = run(true);
  ok(fixed.applied && fixed.settled.length === 0, 'with the payment recorded on Nov 1, the category path settles nothing else', JSON.stringify(fixed.settled));
  ok(fixed.nov && fixed.nov.status === 'PAID' && fixed.nov.settlement === 'represented', 'the Nov 1 minimum reads paid');
  ok(fixed.dec && fixed.dec.status === 'still due' && fixed.dec.settlement === 'upcoming'
    && JSON.stringify(fixed.walk) === JSON.stringify(['cashback-day4@2035-12-04']),
    'the Dec 4 minimum stays due and is the one Cash Back minimum still taken from cash', JSON.stringify(fixed.walk));
  const mutant = run(false);
  ok(mutant.applied && JSON.stringify(mutant.settled) === JSON.stringify(['cashback-day4@2035-12-04']) && mutant.walk.length === 0,
    'mutant: without the recorded payment the same payment also settles Dec 4 (the double settle is caught)', JSON.stringify(mutant));
}

console.log(failures ? `${failures} of ${checks} FAILED` : `All ${checks} TD card statement checks passed`);
process.exit(failures ? 1 : 0);
