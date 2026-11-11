'use strict';
/* Independent proof that Forecast can represent an every-3-month obligation.
 *
 * Dates below are hand-computed from AUG16-004 and the calendar, not taken
 * from Forecast.occurrences. The engine is then asked whether it reproduces
 * that list. A test that built the expected dates with the same helper would
 * only prove consistency.
 *
 * `node test/test-quarterly-recurrence.js`
 */
const F = require('../public/forecast.js');
const data = require('../data.json');
const periods = require('../public/periods.json');
const icsMod = require('../scripts/calendar-ics.js');
const { sourceText } = require('./test-source-text');
const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const clone = x => JSON.parse(JSON.stringify(x));
const sameDates = (got, want) => JSON.stringify(got) === JSON.stringify(want);

const plan = data.plan;
const asOf = data.meta.asOf;
const viewEnd = F.addDays(asOf, (plan.windowDays || 91) - 1);
const horizon = F.knowledgeHorizon(plan, asOf);
const icsEnd = icsMod.ICS_HORIZON_END;

// AUG16-004: every 3 months on the 18th. Observed payment 18 March 2026.
// Next forward due is 18 September 2026 — June is not invented as arrears.
// Hand addition of three calendar months, keeping day 18:
//   2026-03-18  observed (phase only)
//   2026-06-18  before the 2026-08-16 opening; not a forecast event
//   2026-09-18  first forward due
//   2026-12-18
//   2027-03-18  year rollover from December
//   2027-06-18
//   2027-09-18  after 2027-08-15 (365-day knowledge end from 2026-08-16)
const HAND_FORWARD = ['2026-09-18', '2026-12-18', '2027-03-18', '2027-06-18'];
const HAND_AMOUNT = 95.85;
const KNOWLEDGE_END = horizon.end;
const VIEW_END = viewEnd;

function nobleEvents(p, start, end, opts) {
  return F.expandEvents(p, start, end, opts).filter(e => e.id === 'noble-garbage');
}

console.log('=== live row is one quarterly schedule, not a once workaround ===');
{
  const noble = (plan.bills || []).find(b => b.id === 'noble-garbage');
  const onceRows = (plan.bills || []).filter(b =>
    b.id === 'noble-garbage' || /noble/i.test(b.id + (b.label || '')));
  ok(!!noble, 'canonical noble-garbage row exists');
  ok(noble && noble.frequency === 'quarterly' && noble.day === 18
    && noble.anchor === '2026-03-18' && noble.firstDue === '2026-09-18'
    && near(noble.amount, HAND_AMOUNT) && noble.date == null,
    'one quarterly row: day 18, March phase, firstDue Sep. 18, no once date');
  ok(onceRows.length === 1, 'no second Noble bill beside it');
  ok(noble && !/no quarterly expander/i.test(noble.note || ''),
    'the temporary expander-gap note is gone');
}

console.log('\n=== hand-computed Noble forward cadence from the current opening ===');
{
  ok(/^\d{4}-\d{2}-\d{2}$/.test(asOf), 'opening as-of is an explicit YYYY-MM-DD date', asOf);
  ok(horizon.days >= 365 && horizon.end === F.addDays(asOf, horizon.days - 1),
    'knowledge end is as-of + (days − 1) and at least 12 months', horizon.end);
  ok(viewEnd === F.addDays(asOf, (plan.windowDays || 91) - 1),
    '91-day view end is derived from the current as-of', viewEnd);

  const dates = F.occurrences({
    frequency: 'quarterly', day: 18,
    anchor: '2026-03-18', firstDue: '2026-09-18',
  }, asOf, horizon.end);
  ok(sameDates(dates, HAND_FORWARD),
    'master horizon reproduces the hand-computed 18ths',
    dates.join(', '));

  const events = nobleEvents(plan, asOf, horizon.end, { keepRepresented: true });
  ok(events.length === HAND_FORWARD.length, 'one live event per hand-computed due',
    String(events.length));
  ok(events.every((e, i) => e.date === HAND_FORWARD[i] && near(-e.amount, HAND_AMOUNT)),
    'each due is exactly $95.85, no extras',
    events.map(e => `${e.date} ${-e.amount}`).join(', '));
  ok(new Set(events.map(e => e.date)).size === events.length,
    'no duplicate Noble dates');
  ok(!events.some(e => e.date === '2026-03-18' || e.date === '2026-06-18'),
    'March history and June are not forecast events');
  ok(!events.some(e => e.date === '2027-09-18') || horizon.end >= '2027-09-18',
    'the next 18th after the knowledge end is not invented into the horizon');
}

console.log('\n=== view truncation does not shrink master knowledge ===');
{
  const view = nobleEvents(plan, asOf, viewEnd, { keepRepresented: true });
  const master = nobleEvents(plan, asOf, horizon.end, { keepRepresented: true });
  ok(view.length === 1 && view[0].date === '2026-09-18',
    'the 91-day view shows only the in-range September due');
  ok(master.length === 4 && sameDates(master.map(e => e.date), HAND_FORWARD),
    'the master walk still knows Dec / Mar / Jun');
  ok(nobleEvents(plan, asOf, viewEnd).length === 0,
    'Dale-gated representedEvents omits the in-range September due from the cash walk');
  ok(sameDates(nobleEvents(plan, asOf, horizon.end).map(e => e.date),
    HAND_FORWARD.filter(d => d !== '2026-09-18')),
    'the master cash walk keeps later dues after omitting the represented September occurrence');

  const recOpts = {
    scenario: plan.defaults.scenario, incomeOverrides: {}, disabled: [],
    extraDebtMonthly: 0, targetBuffer: plan.defaults.targetBuffer,
    fundingSources: (plan.funding || {}).options,
    extraFacilities: data.revolvingExtra,
    extraDebtTarget: plan.nextDollar && plan.nextDollar.target,
    debts: data.debts,
  };
  const rec = F.recommend(plan, asOf, recOpts);
  ok(rec.knowledge.end === KNOWLEDGE_END && rec.simOptions.horizonDays === horizon.days,
    'recommend searches the ≥12-month knowledge horizon');
  ok((rec.sim.events || []).filter(e => e.id === 'noble-garbage').length === 0,
    'the displayed 91-day sim omits the represented September due');
  const masterSim = F.simulate(plan, asOf, Object.assign({}, rec.simOptions, {
    weeklyVariable: rec.weekly, horizonDays: horizon.days,
    viewDays: horizon.days, viewStart: asOf,
  }));
  ok(sameDates(masterSim.events.filter(e => e.id === 'noble-garbage').map(e => e.date),
    HAND_FORWARD.filter(d => d !== '2026-09-18')),
    'the same recommend options, walked to the knowledge end, keep later dues and omit the represented September occurrence');

  const ics = icsMod.buildHouseholdCalendar(plan, asOf, icsEnd);
  const icsNoble = ics.payments.filter(p => p.sourceId === 'noble-garbage')
    .map(p => p.start).sort();
  // ICS_HORIZON_END is 2027-05-01, so June 2027 is outside that export view.
  ok(sameDates(icsNoble, ['2026-12-18', '2027-03-18']),
    'ICS cash VEVENTs follow expandEvents, omitting the represented September due',
    icsNoble.join(', '));
  ok(!ics.payments.some(p => p.sourceId === 'noble-garbage' && p.start === '2027-06-18'),
    'the ICS view truncation does not delete June from the master plan');
}

console.log('\n=== old once workaround vs quarterly: event count ===');
{
  const oncePlan = clone(plan);
  const row = oncePlan.bills.find(b => b.id === 'noble-garbage');
  row.frequency = 'once';
  row.date = '2026-09-18';
  delete row.day;
  delete row.anchor;
  delete row.firstDue;
  const onceCount = nobleEvents(oncePlan, asOf, horizon.end, { keepRepresented: true }).length;
  const liveCount = nobleEvents(plan, asOf, horizon.end, { keepRepresented: true }).length;
  ok(onceCount === 1, 'the retired once representation had one master event');
  ok(liveCount === 4, 'the quarterly row has four master events inside ≥12 months');
  ok(near((liveCount - onceCount) * HAND_AMOUNT, 287.55),
    'three newly visible dues are 3 × $95.85 = $287.55');
}

console.log('\n=== amount change on the canonical row reaches every schedule consumer ===');
{
  const edited = clone(plan);
  const row = edited.bills.find(b => b.id === 'noble-garbage');
  row.amount = 111.11;
  const events = nobleEvents(edited, asOf, horizon.end, { keepRepresented: true });
  ok(events.length === 4 && events.every(e => near(-e.amount, 111.11)),
    'expandEvents / simulate stream follows the new amount');

  const ics = icsMod.buildHouseholdCalendar(edited, asOf, icsEnd);
  const icsNoble = ics.payments.filter(p => p.sourceId === 'noble-garbage');
  ok(icsNoble.length === 2 && icsNoble.every(p => near(p.amount, 111.11)),
    'ICS payment VEVENTs follow the same Plan amount and omit the represented September due');

  const nextDue = F.nextDue(
    F.expandEvents(edited, asOf, viewEnd, { keepRepresented: true }).filter(e => e.id === 'noble-garbage'),
    asOf);
  ok(nextDue && nextDue.due === '2026-09-18' && near(nextDue.amount, 111.11),
    'nextDue reads the edited Noble occurrence from expandEvents',
    nextDue ? `${nextDue.due} $${nextDue.amount}` : 'none');

  const out = F.nextPaymentOut(
    F.expandEvents(edited, asOf, viewEnd, { keepRepresented: true }).filter(e => e.id === 'noble-garbage'),
    asOf);
  ok(out && out.date === '2026-09-18' && near(out.amount, 111.11),
    'nextPaymentOut sums the same edited stream',
    out ? `${out.date} $${out.amount}` : 'none');

  const budget = F.budgetBreakdown(edited, periods, {
    paypalPerMonth: data.paypal && data.paypal.perMonth,
    asOf,
  });
  const household = budget.categories.find(c => c.id === 'household');
  const fortis = edited.bills.find(b => b.id === 'fortis');
  ok(near(household.dated, fortis.amount + 111.11 / 3),
    'budget dated subtraction uses amount/3, not a frozen $95.85',
    String(household.dated));
}

console.log('\n=== synthetic every-3-months primitive (not a Noble date list) ===');
{
  // Fully specified: firstDue is the phase. Hand list from 15 Jan 2026:
  // 15 Jan, 15 Apr, 15 Jul, 15 Oct.
  const item = { frequency: 'quarterly', day: 15, firstDue: '2026-01-15' };
  ok(sameDates(F.occurrences(item, '2026-01-10', '2026-12-31'),
    ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']),
    'start before first matching day: Jan/Apr/Jul/Oct 15');

  ok(sameDates(F.occurrences(item, '2026-01-15', '2026-12-31'),
    ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']),
    'start exactly on a due date includes that date');

  ok(sameDates(F.occurrences(item, '2026-01-10', '2026-01-15'),
    ['2026-01-15']),
    'end exactly on a due date includes that date');

  ok(sameDates(F.occurrences(
    { frequency: 'quarterly', day: 18, firstDue: '2026-09-18' },
    '2026-12-01', '2027-03-31'),
    ['2026-12-18', '2027-03-18']),
    'a range spanning a year boundary keeps day 18');

  ok(sameDates(F.occurrences(
    { frequency: 'quarterly', day: 18, firstDue: '2026-09-18' },
    '2026-10-01', '2026-11-30'),
    []),
    'a range containing no 18th-every-3-months due is empty');

  // 31 Jan + 3 months = 30 Apr (April has 30 days); then 31 Jul; 31 Oct.
  ok(sameDates(F.occurrences(
    { frequency: 'quarterly', day: 31, firstDue: '2026-01-31' },
    '2026-01-01', '2026-12-31'),
    ['2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31']),
    'day 31 clamps on shorter months, same rule as monthly');
}

console.log('\n=== one fully specified cadence, two view starts ===');
{
  // Same row, two windows. Hand list is still Jan/Apr/Jul/Oct 15.
  // A Feb start may drop January; it must not invent Feb/May/Aug/Nov.
  const item = { frequency: 'quarterly', day: 15, firstDue: '2026-01-15' };
  const fromJan = F.occurrences(item, '2026-01-10', '2026-12-31');
  const fromFeb = F.occurrences(item, '2026-02-01', '2026-12-31');
  ok(sameDates(fromJan, ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']),
    'Jan 10 view is the Jan-phase slice');
  ok(sameDates(fromFeb, ['2026-04-15', '2026-07-15', '2026-10-15']),
    'Feb 1 view is a later slice of the same cadence, not Feb/May/Aug/Nov');
}

console.log('\n=== under-specified quarterly cannot invent a phase ===');
{
  const item = { frequency: 'quarterly', day: 15 };
  ok(sameDates(F.occurrences(item, '2026-01-10', '2026-12-31'), []),
    'missing anchor and firstDue from Jan 10 yields no dates');
  ok(sameDates(F.occurrences(item, '2026-02-01', '2026-12-31'), []),
    'the same under-specified row from Feb 1 also yields no dates, not a Feb-phase invention');
}

console.log('\n=== firstDue omits a mid-cycle date without shifting the phase ===');
{
  // Range includes June. Anchor is the March observation. firstDue is September.
  // Hand list: Mar 18 (before start and before firstDue), Jun 18 (in range but
  // before firstDue — not arrears), Sep 18, Dec 18.
  const dates = F.occurrences({
    frequency: 'quarterly', day: 18,
    anchor: '2026-03-18', firstDue: '2026-09-18',
  }, '2026-06-01', '2026-12-31');
  ok(sameDates(dates, ['2026-09-18', '2026-12-18']),
    'June in-range is omitted; September and December remain',
    dates.join(', '));
}

console.log('\n=== no second recurrence or calendar authority ===');
{
  const forecastSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'public', 'forecast.js'), 'utf8'));
  const icsSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'calendar-ics.js'), 'utf8'));
  const planSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'public', 'plan.js'), 'utf8'));
  ok(/function quarterlyDates/.test(forecastSrc)
    && /item\.frequency === 'quarterly'/.test(forecastSrc),
    'the quarterly expander lives inside Forecast.occurrences');
  ok(/Forecast\.expandEvents/.test(icsSrc),
    'ICS cash VEVENTs still derive from expandEvents');
  ok(!/function quarterlyDates/.test(icsSrc) && !/function quarterlyDates/.test(planSrc),
    'plan.js and calendar-ics.js did not grow a second expander');
  ok(!/RRULE|rrule|luxon|rrule\.js|fullcalendar/i.test(forecastSrc),
    'no RRULE / generic calendar library was added to Forecast');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
