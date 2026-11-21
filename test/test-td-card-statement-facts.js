'use strict';
/* Owner facts 2026-11-21 (Dale, his two TD card statements, read from his banking app; lead dispatch).
 *
 * TD Cash Back Visa: the minimum is due on the 4th. `cashback` ends at its 2026-11-01 occurrence (lastDue) and the
 * successor `cashback-day4` carries the schedule on from 2026-12-04, whose statement minimum is owner-confirmed;
 * later months stay estimated at the existing level.
 * The same Cash Back statement shows a last payment on 2026-11-09 and no past-due amount, so the 2026-11-01 minimum is
 * represented effective 2026-11-09 (lead, 2026-11-21).
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
ok(cbRep.length === 1 && cbRep[0].effectiveAsOf === '2026-11-09' && !(cashback.sentPayments || []).some(p => p.scheduledDate === '2026-11-01'),
  'cashback: the 2026-11-01 minimum is represented effective 2026-11-09 (the last payment), with no payment amount recorded');
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
ok(shown.length >= 3 && shown.every(r => TRAVEL_DATES.includes(r.date) && r.settlement === 'represented' && r.status === 'PAID'),
  'acceptance 2: every Travel minimum through Nov 26 on the page reads paid (represented)',
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
  ok(F.expandEvents(noCb, AS_OF, '2026-12-31', {}).some(e => e.id === 'cashback' && e.date === '2026-11-01'),
    'without its represented entry the 2026-11-01 Cash Back minimum is carried again');
  const noEnd = views(livePlan(p => { delete p.obligations.find(o => o.id === 'cashback').lastDue; }));
  ok(rows(period(noEnd, '2026-11-20'), /^cashback$/).some(r => r.date === '2026-12-01'),
    'without lastDue a Dec 1 Cash Back minimum returns to Nov 20-Dec 3 (beside the Dec 4 one)');
  const early = views(livePlan(p => { p.opening.representedEvents.filter(e => e.id === 'travel').forEach(e => { e.effectiveAsOf = '2026-11-22'; }); }));
  ok(rows(period(early, '2026-10-23'), /^travel$/)[0].settlement === 'unverified',
    'an effective date after the opening does not settle them (the 2026-11-19 date is what qualifies them)');
}

console.log(failures ? `${failures} of ${checks} FAILED` : `All ${checks} TD card statement checks passed`);
process.exit(failures ? 1 : 0);
